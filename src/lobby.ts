const tickRate = 10;
const maxEmptyTicks = tickRate * 30;// tickRate * seconds

const OP_READY = 1;
const OP_LOBBY_UPDATE = 2;
const OP_GAME_START = 3;

enum GameState { WaitingForPlayers, WaitingForPlayersReady, Launching, InProgress }

interface LobbyMatchState extends nkruntime.MatchState {
    players: { [sessionId: string]: PlayerState },
    playerCount: number,
    requiredPlayerCount: number,
    isPrivate: boolean,
    gameState: GameState,
    emptyTicks: number,
    matchName: string,
    slotNumber: number,
    launched: boolean,
    canJoin: boolean,
    serverStartResult: ServerStartResult
}

interface ServerStartOK {
    matchId: string,
    port: number,
    ip: string,
}

interface ServerStartResult {
    success: ServerStartOK | null,
    error: Error | null,
}

interface PlayerState {
    presence: nkruntime.Presence | null,
    displayName: string,
    userId: string,
    isReady: boolean,
    slotNumber: number,
    isObserving: boolean
}

function makeLabel(state: LobbyMatchState): string {
    return JSON.stringify({
        isPrivate: state.isPrivate.toString(),
        playerCount: state.playerCount,
        requiredPlayerCount: state.requiredPlayerCount,
        matchName: state.matchName,
        canJoin: state.canJoin.toString(),
    });
}

function updateObserverFlags(state: LobbyMatchState) {
    let orderedPlayers = Object.keys(state.players)
        .map(k => state.players[k])
        .sort((a, b) => a.slotNumber - b.slotNumber);

    orderedPlayers.slice(0, 2).forEach(ps => ps.isObserving = false);
    orderedPlayers.slice(2).forEach(ps => ps.isObserving = true);
}

function broadcastLobbyUpdate(logger: nkruntime.Logger, state: LobbyMatchState, dispatcher: nkruntime.MatchDispatcher) {
    let players = Object.keys(state.players)
        .map(k => {
            var player = state.players[k];
            if (player.presence === null)
                return null;
            return {
                sessionId: player.presence.sessionId,
                isObserving: player.isObserving,
                isReady: player.isReady,
                displayName: player.displayName,
                userId: player.presence.userId,
            };
        })
        .filter(x => x !== null);
    let lobbyUpdate = {
        players: players,
    };

    logger.info(JSON.stringify(lobbyUpdate));
    dispatcher.broadcastMessage(OP_LOBBY_UPDATE, JSON.stringify(lobbyUpdate));
}

const MatchInit: nkruntime.MatchInitFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: {[key: string]: string}) {
    // Determine if the match should be private based on the passed in params
    const isPrivate = params.isPrivate === "true";
    const matchName = params.matchName;
  
    // Define the match state
    const state: LobbyMatchState= {
        players: {},
        isPrivate,
        playerCount: 0,
        requiredPlayerCount: 2,
        allowedObservers: 3,
        gameState: GameState.WaitingForPlayers,
        emptyTicks: 0,
        matchName,
        slotNumber: 0,
        launched: false,
        canJoin: true,
        serverStartResult: {
            success: null,
            error: null
        }
    };
  
    const label = makeLabel(state);
    return {
        state,
        tickRate,
        label
    };
};

const MatchJoinAttempt: nkruntime.MatchJoinAttemptFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, presence: nkruntime.Presence, metadata: {[key: string]: any }) {
    // Accept new players unless the required amount has been fulfilled
    let accept = true;
    if (Object.keys(state.players).length >= state.requiredPlayerCount + state.allowedObservers) {
        accept = false;
    }
  
    if (accept) {
        // Reserve the spot in the match
        state.players[presence.sessionId] = {
            presence: null,
            isReady: false,
            slotNumber: state.slotNumber,
            isObserving: false,
            displayName: "",
            userId: ""
        };
        state.slotNumber++;
    }
    
    return {
        state,
        accept
    };
};

const MatchJoin: nkruntime.MatchJoinFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, presences: nkruntime.Presence[]) {
    const users: { [userId: string]: nkruntime.User } = {}
    for (var u of nk.usersGetId(presences.map(p => p.userId))) {
        users[u.userId] = u;
    }

    // Populate the presence property for each player
    presences.forEach(function (presence) {
        var p = state.players[presence.sessionId];
        p.userId = presence.userId;
        p.displayName = users[presence.userId].displayName;
        state.players[presence.sessionId].presence = presence;
        state.playerCount++;
    });
    
    // If the match is full then update the state
    if (state.playerCount >= state.requiredPlayerCount) {
        state.gameState = GameState.WaitingForPlayersReady;
    }
  
    updateObserverFlags(state);
    broadcastLobbyUpdate(logger, state, dispatcher);

    // Update the match label
    const label = makeLabel(state);
    dispatcher.matchLabelUpdate(label);
  
    return {
        state
    };
};

const MatchLeave: nkruntime.MatchLeaveFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, presences: nkruntime.Presence[]) {
    // Remove the player from match state
    presences.forEach(function (presence) {
        delete(state.players[presence.sessionId]);
        state.playerCount--;
    });
  
    updateObserverFlags(state);
    broadcastLobbyUpdate(logger, state, dispatcher);

    return {
        state
    };
};

const MatchLoop: nkruntime.MatchLoopFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, messages: nkruntime.MatchMessage[]) {
    // If the match is empty, increment the empty ticks
    if (state.playerCount === 0) {
        state.emptyTicks++;
    } else {
        state.emptyTicks = 0;
    }

    let shouldBroadcastLobbyUpdate = false;
    messages.forEach(m => {
        switch (m.opCode) {
            case OP_READY:
                state.players[m.sender.sessionId].isReady = true;
                dispatcher.broadcastMessage(OP_READY, JSON.stringify({ sessionId: m.sender.sessionId }));
                shouldBroadcastLobbyUpdate = true;
                break;
        }
    });

    if (shouldBroadcastLobbyUpdate) {
        broadcastLobbyUpdate(logger, state, dispatcher);        
    }

    if (state.gameState == GameState.Launching) {
        if (state.serverStartResult.success !== null) {
            logger.info("I should send a message to the clients now");
            state.gameState = GameState.InProgress;
        } else if (state.serverStartResult.error !== null) {
            logger.error("Failed to start game server");
            logger.error(state.serverStartResult.error.toString());
            return null;
        }
    } else if (state.gameState == GameState.WaitingForPlayersReady) {
        let allReady = true;
        Object.keys(state.players).forEach(sessionId => {
            var player = state.players[sessionId];
            if (!player.isObserving && !player.isReady) {
                allReady = false;
            }
        });

        if (allReady) {
            state.canJoin = false;
            state.gameState = GameState.InProgress;            

            fetch(
                "https://localhost:7152/gameserver",
                {
                    method: "POST",
                    cache: "no-cache",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    redirect: "follow",
                    body: JSON.stringify({ matchId: state.matchId }), // body data type must match "Content-Type" header
                })
                .then(response => response.json().then(x => {
                    logger.info("Success");
                    logger.info(x.toString());
                    state.serverStartResult.success = x;
                }))
                .catch(e => {
                    logger.error("Failure");
                    logger.error(e.toString());
                    state.serverStartResult.error = e;
                });
        }
    }

    // If the match has been empty for too long, end it
    if (state.emptyTicks >= maxEmptyTicks) {
        return null;
    }
 
   return {
       state
   };
};

const MatchTerminate: nkruntime.MatchTerminateFunction<LobbyMatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, graceSeconds: number) {
    return {
        state
    };
};
  
const MatchSignal: nkruntime.MatchSignalFunction<LobbyMatchState>= function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: LobbyMatchState, data: string) {
    return {
        state,
        data
    };
};

const CreateLobbyMatchRpc: nkruntime.RpcFunction = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
    fetch(
        "https://localhost:7152/gameserver",
        {
            method: "POST",
            cache: "no-cache",
            headers: {
                "Content-Type": "application/json",
            },
            redirect: "follow",
            body: JSON.stringify({ matchId: "300" }), // body data type must match "Content-Type" header
        });

    // Assume the match will be public by default
    let isPrivate = "false";
    let matchName = `Play with ${ctx.username}`;

    var users = nk.usersGetId([ctx.userId]);
    logger.info(JSON.stringify(users))

    if (payload) {
        const data = JSON.parse(payload);
        if (data.isPrivate) {
            isPrivate = data.isPrivate.toString();
        }
        if (users.length > 0) {
            matchName = `Play with ${users[0].displayName}${data.isPrivate ? " (Private)" : ""}`;
        }
    }

    logger.info(payload)
    
    // Create the match and return the match ID to the player
    const matchId = nk.matchCreate("LobbyMatch", { isPrivate, matchName });
    return JSON.stringify({ matchId });
};

