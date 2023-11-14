package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

var (
	errInternalError  = runtime.NewError("internal server error", 13) // INTERNAL
	errMarshal        = runtime.NewError("cannot marshal type", 13)   // INTERNAL
	errNoInputAllowed = runtime.NewError("no input allowed", 3)       // INVALID_ARGUMENT
	errNoUserIdFound  = runtime.NewError("no user ID in context", 3)  // INVALID_ARGUMENT
	errUnmarshal      = runtime.NewError("cannot unmarshal type", 13) // INTERNAL
)

const (
	rpcIdRewards   = "rewards"
	rpcIdFindMatch = "find_match"
)

// noinspection GoUnusedExportedFunction
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	initStart := time.Now()

	if err := initializer.RegisterMatch("LobbyMatch", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
		return &LobbyMatch{}, nil
	}); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("create-lobby", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
		// Assume the match will be public by default
		isPrivate := false
		matchName := fmt.Sprintf("Play with %s", ctx.Value(runtime.RUNTIME_CTX_USERNAME).(string))

		userId := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
		users, _ := nk.UsersGetId(ctx, []string{userId}, nil)

		// Get the isPrivate value from the payload if it exists
		var data map[string]interface{}
		if err := json.Unmarshal([]byte(payload), &data); err != nil {
			logger.Error("error unmarshaling payload: %v", err)
			return "", err
		}

		if val, ok := data["isPrivate"]; ok {
			isPrivate = val.(bool)
		}
		if len(users) > 0 {
			privateSuffix := ""
			if isPrivate {
				privateSuffix = " (Private)"
			}
			matchName = fmt.Sprintf("Play with %s%s", users[0].DisplayName, privateSuffix)
		}

		params := map[string]interface{}{
			"isPrivate": isPrivate,
		}

		// Create the match and return the match ID to the player
		matchId, err := nk.MatchCreate(ctx, "LobbyMatch", params)
		if err != nil {
			return "", err
		}

		response := map[string]interface{}{
			"matchId":   matchId,
			"matchName": matchName,
			"canJoin":   true,
		}

		bytes, err := json.Marshal(response)
		if err != nil {
			logger.Error("error marshaling response: %v", err)
			return "", err
		}

		return string(bytes), nil
	}); err != nil {
		logger.Error("unable to register create match rpc: %v", err)
		return err
	}

	logger.Info("Plugin loaded in '%d' msec.", time.Now().Sub(initStart).Milliseconds())
	return nil
}
