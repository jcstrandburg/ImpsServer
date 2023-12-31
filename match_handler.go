package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io/ioutil"
	"net/http"
	"strconv"

	"context"
	"sort"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
	"github.com/thoas/go-funk"
)

const tickRate int = 10
const maxEmptyTicks int = tickRate * 10 // tickRate * seconds

const OP_READY = 1
const OP_LOBBY_UPDATE = 2
const OP_GAME_START = 3

type LobbyMatch struct{}
type GameState int

type LobbyMatchState struct {
	Players             map[string]*PlayerState
	PlayerCount         int
	RequiredPlayerCount int
	IsPrivate           bool
	GameState           GameState
	EmptyTicks          int
	SlotNumber          int
	AllowedPlayerCount  int
	AllowedObservers    int
	MatchName           string
	CanJoin             bool
	MatchId             string
}

type PlayerState struct {
	Presence    runtime.Presence
	IsReady     bool
	SlotNumber  int
	IsObserving bool
	DisplayName string
	UserId      string
}

const (
	WaitingForPlayers      GameState = 0
	WaitingForPlayersReady GameState = 1
	Launching              GameState = 2 // Get rid of this
	InProgress             GameState = 3
)

func toJson(thing interface{}) string {
	ret, err := json.Marshal(thing)
	if err != nil {
		panic(err)
	}
	return string(ret)
}

func toJsonBytes(thing interface{}) []byte {
	ret, err := json.Marshal(thing)
	if err != nil {
		panic(err)
	}
	return ret
}

func getLabel(state *LobbyMatchState) string {
	label := map[string]interface{}{
		"isPrivate":   strconv.FormatBool(state.IsPrivate),
		"playerCount": state.PlayerCount,
		"matchName":   state.MatchName,
		"canJoin":     strconv.FormatBool(state.CanJoin),
	}
	return toJson(label)
}

func values[M ~map[K]V, K comparable, V any](m M) []V {
	r := make([]V, 0, len(m))
	for _, v := range m {
		r = append(r, v)
	}
	return r
}

func updateObserverFlags(state *LobbyMatchState) {
	players := values(state.Players)
	sort.Slice(players, func(a, b int) bool {
		return players[a].SlotNumber < players[b].SlotNumber
	})

	for ix, p := range players {
		p.IsObserving = ix >= 2
	}
}

func broadcastLobbyUpdate(logger runtime.Logger, state *LobbyMatchState, dispatcher runtime.MatchDispatcher) {
	players := funk.Filter(values(state.Players), func(p *PlayerState) bool {
		return p.Presence != nil
	})

	playerDtos := funk.Map(players, func(p *PlayerState) map[string]interface{} {
		return map[string]interface{}{
			"sessionId":   p.Presence.GetSessionId(),
			"isObserving": p.IsObserving,
			"isReady":     p.IsReady,
			"displayName": p.DisplayName,
			"userId":      p.Presence.GetUserId(),
		}
	})
	lobbyDto := map[string]interface{}{
		"players": playerDtos,
	}
	bytes, err := json.Marshal(lobbyDto)
	if err != nil {
		panic(err)
	}
	logger.Info(string(bytes))

	err = dispatcher.BroadcastMessage(OP_LOBBY_UPDATE, bytes, nil, nil, true)
	if err != nil {
		panic(err)
	}
}

func broadcastGameStarted(logger runtime.Logger, state *LobbyMatchState, dispatcher runtime.MatchDispatcher, responseBytes []byte) {
	err := dispatcher.BroadcastMessage(OP_GAME_START, responseBytes, nil, nil, true)
	if err != nil {
		panic(err)
	}
}

func spinUpServer(matchId string) ([]byte, error) {
	jsonBytes, err := json.Marshal(map[string]interface{}{"matchId": matchId})
	if err != nil {
		return nil, err
	}

	address := "http://172.21.214.52:5000/GameServer"
	address = "http://localhost:5000/GameServer"
	address = "http://servermanager:5000/GameServer"
	resp, err := http.Post(address, "application/json", bytes.NewBuffer(jsonBytes))
	if err != nil {
		println("Error during post")
		return nil, err
	}

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	return body, nil
}

func (m *LobbyMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	isPrivate := false
	matchName := ""

	if val, ok := params["isPrivate"]; ok {
		isPrivate = val.(bool)
	}
	if val, ok := params["matchName"]; ok {
		matchName = val.(string)
	}

	state := &LobbyMatchState{
		Players:             make(map[string]*PlayerState),
		PlayerCount:         0,
		RequiredPlayerCount: 2,
		IsPrivate:           isPrivate,
		GameState:           WaitingForPlayers,
		EmptyTicks:          0,
		CanJoin:             true,
		MatchName:           matchName,
		MatchId:             ctx.Value(runtime.RUNTIME_CTX_MATCH_ID).(string),
	}

	return state, tickRate, getLabel(state)
}

func (m *LobbyMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, stateInterface interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	state, ok := stateInterface.(*LobbyMatchState)
	if !ok {
		panic("State is not a valid type")
	}

	// Accept new players unless the required amount has been fulfilled
	accept := true
	reason := ""
	if len(state.Players) >= state.RequiredPlayerCount+state.AllowedObservers {
		accept = false
		reason = "Match full"
	}

	if accept {
		// Reserve the spot in the match
		state.Players[presence.GetSessionId()] = &PlayerState{
			Presence:    nil,
			IsReady:     false,
			SlotNumber:  state.SlotNumber,
			IsObserving: false,
			DisplayName: "",
			UserId:      "",
		}
		state.SlotNumber++
	}

	return state, accept, reason
}

func (m *LobbyMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, stateInterface interface{}, presences []runtime.Presence) interface{} {
	state, ok := stateInterface.(*LobbyMatchState)
	if !ok {
		panic("State is not a valid type")
	}

	userIds := funk.Map(presences, func(p runtime.Presence) string {
		return p.GetUserId()
	}).([]string)

	nkUsers, _ := nk.UsersGetId(ctx, userIds, []string{})
	users := make(map[string]*api.User)
	for _, u := range nkUsers {
		users[u.Id] = u
	}

	// Populate the presence property for each player
	for _, p := range presences {
		player := state.Players[p.GetSessionId()]
		player.Presence = p
		player.UserId = p.GetUserId()
		player.DisplayName = users[p.GetUserId()].DisplayName
		state.PlayerCount = len(state.Players)
	}

	// If the match is full then update the state
	if len(state.Players) >= state.RequiredPlayerCount {
		state.GameState = WaitingForPlayersReady
	}

	updateObserverFlags(state)
	broadcastLobbyUpdate(logger, state, dispatcher)

	// Update the match label
	label := getLabel(state)
	dispatcher.MatchLabelUpdate(label)

	return state
}

func (m *LobbyMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, stateInterface interface{}, presences []runtime.Presence) interface{} {
	state, ok := stateInterface.(*LobbyMatchState)
	if !ok {
		panic("State is not a valid type")
	}

	for _, presence := range presences {
		delete(state.Players, presence.GetSessionId())
		state.PlayerCount--
	}

	updateObserverFlags(state)
	broadcastLobbyUpdate(logger, state, dispatcher)

	return state
}

func (m *LobbyMatch) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, stateInterface interface{}, messages []runtime.MatchData) interface{} {
	state, ok := stateInterface.(*LobbyMatchState)
	if !ok {
		panic("State is not a valid type")
	}

	// If the match is empty, increment the empty ticks
	if state.PlayerCount == 0 {
		state.EmptyTicks++
		// If the match has been empty for too long, end it
		if state.EmptyTicks > maxEmptyTicks {
			return nil
		}
	} else {
		state.EmptyTicks = 0
	}

	shouldBroadcastLobbyUpdate := false
	for _, m := range messages {
		switch op := m.GetOpCode(); op {
		case OP_READY:
			sessionId := m.GetSessionId()
			state.Players[sessionId].IsReady = true
			dto := map[string]interface{}{
				"sessionId": sessionId,
			}

			dispatcher.BroadcastMessage(OP_READY, toJsonBytes(dto), nil, nil, true)
			shouldBroadcastLobbyUpdate = true
			break
		}
	}

	if shouldBroadcastLobbyUpdate {
		broadcastLobbyUpdate(logger, state, dispatcher)
	}

	if state.GameState == WaitingForPlayersReady {
		readyCount := 0
		for _, p := range state.Players {
			if !p.IsObserving && p.IsReady {
				readyCount++
			}
		}

		if readyCount >= state.RequiredPlayerCount {
			responseBytes, err := spinUpServer(state.MatchId)
			if err != nil {
				panic(err)
			}

			state.GameState = InProgress
			state.CanJoin = false

			broadcastGameStarted(logger, state, dispatcher, responseBytes)
		}
	}

	return state
}

func (m *LobbyMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	return state
}

func (m *LobbyMatch) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, data string) (interface{}, string) {
	return state, data
}
