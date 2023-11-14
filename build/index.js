function InitModule(ctx, logger, nk, initializer) {
    initializer.registerMatch("LobbyMatch", {
        matchInit: MatchInit,
        matchJoinAttempt: MatchJoinAttempt,
        matchJoin: MatchJoin,
        matchLeave: MatchLeave,
        matchLoop: MatchLoop,
        matchSignal: MatchSignal,
        matchTerminate: MatchTerminate
    });
    initializer.registerRpc("create-lobby", CreateLobbyMatchRpc);
}
var tickRate = 10;
var maxEmptyTicks = tickRate * 30;
var OP_READY = 1;
var OP_LOBBY_UPDATE = 2;
var OP_GAME_START = 3;
var GameState;
(function (GameState) {
    GameState[GameState["WaitingForPlayers"] = 0] = "WaitingForPlayers";
    GameState[GameState["WaitingForPlayersReady"] = 1] = "WaitingForPlayersReady";
    GameState[GameState["Launching"] = 2] = "Launching";
    GameState[GameState["InProgress"] = 3] = "InProgress";
})(GameState || (GameState = {}));
function makeLabel(state) {
    return JSON.stringify({
        isPrivate: state.isPrivate.toString(),
        playerCount: state.playerCount,
        requiredPlayerCount: state.requiredPlayerCount,
        matchName: state.matchName,
        canJoin: state.canJoin.toString(),
    });
}
function updateObserverFlags(state) {
    var orderedPlayers = Object.keys(state.players)
        .map(function (k) { return state.players[k]; })
        .sort(function (a, b) { return a.slotNumber - b.slotNumber; });
    orderedPlayers.slice(0, 2).forEach(function (ps) { return ps.isObserving = false; });
    orderedPlayers.slice(2).forEach(function (ps) { return ps.isObserving = true; });
}
function broadcastLobbyUpdate(logger, state, dispatcher) {
    var players = Object.keys(state.players)
        .map(function (k) {
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
        .filter(function (x) { return x !== null; });
    var lobbyUpdate = {
        players: players,
    };
    logger.info(JSON.stringify(lobbyUpdate));
    dispatcher.broadcastMessage(OP_LOBBY_UPDATE, JSON.stringify(lobbyUpdate));
}
var MatchInit = function (ctx, logger, nk, params) {
    var isPrivate = params.isPrivate === "true";
    var matchName = params.matchName;
    var state = {
        players: {},
        isPrivate: isPrivate,
        playerCount: 0,
        requiredPlayerCount: 2,
        allowedObservers: 3,
        gameState: GameState.WaitingForPlayers,
        emptyTicks: 0,
        matchName: matchName,
        slotNumber: 0,
        launched: false,
        canJoin: true,
        serverStartResult: {
            success: null,
            error: null
        }
    };
    var label = makeLabel(state);
    return {
        state: state,
        tickRate: tickRate,
        label: label
    };
};
var MatchJoinAttempt = function (ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
    var accept = true;
    if (Object.keys(state.players).length >= state.requiredPlayerCount + state.allowedObservers) {
        accept = false;
    }
    if (accept) {
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
        state: state,
        accept: accept
    };
};
var MatchJoin = function (ctx, logger, nk, dispatcher, tick, state, presences) {
    var users = {};
    for (var _i = 0, _a = nk.usersGetId(presences.map(function (p) { return p.userId; })); _i < _a.length; _i++) {
        var u = _a[_i];
        users[u.userId] = u;
    }
    presences.forEach(function (presence) {
        var p = state.players[presence.sessionId];
        p.userId = presence.userId;
        p.displayName = users[presence.userId].displayName;
        state.players[presence.sessionId].presence = presence;
        state.playerCount++;
    });
    if (state.playerCount >= state.requiredPlayerCount) {
        state.gameState = GameState.WaitingForPlayersReady;
    }
    updateObserverFlags(state);
    broadcastLobbyUpdate(logger, state, dispatcher);
    var label = makeLabel(state);
    dispatcher.matchLabelUpdate(label);
    return {
        state: state
    };
};
var MatchLeave = function (ctx, logger, nk, dispatcher, tick, state, presences) {
    presences.forEach(function (presence) {
        delete (state.players[presence.sessionId]);
        state.playerCount--;
    });
    updateObserverFlags(state);
    broadcastLobbyUpdate(logger, state, dispatcher);
    return {
        state: state
    };
};
var MatchLoop = function (ctx, logger, nk, dispatcher, tick, state, messages) {
    if (state.playerCount === 0) {
        state.emptyTicks++;
    }
    else {
        state.emptyTicks = 0;
    }
    var shouldBroadcastLobbyUpdate = false;
    messages.forEach(function (m) {
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
        }
        else if (state.serverStartResult.error !== null) {
            logger.error("Failed to start game server");
            logger.error(state.serverStartResult.error.toString());
            return null;
        }
    }
    else if (state.gameState == GameState.WaitingForPlayersReady) {
        var allReady_1 = true;
        Object.keys(state.players).forEach(function (sessionId) {
            var player = state.players[sessionId];
            if (!player.isObserving && !player.isReady) {
                allReady_1 = false;
            }
        });
        if (allReady_1) {
            state.canJoin = false;
            state.gameState = GameState.InProgress;
            fetch("https://localhost:7152/gameserver", {
                method: "POST",
                cache: "no-cache",
                headers: {
                    "Content-Type": "application/json",
                },
                redirect: "follow",
                body: JSON.stringify({ matchId: state.matchId }),
            })
                .then(function (response) { return response.json().then(function (x) {
                logger.info("Success");
                logger.info(x.toString());
                state.serverStartResult.success = x;
            }); })
                .catch(function (e) {
                logger.error("Failure");
                logger.error(e.toString());
                state.serverStartResult.error = e;
            });
        }
    }
    if (state.emptyTicks >= maxEmptyTicks) {
        return null;
    }
    return {
        state: state
    };
};
var MatchTerminate = function (ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    return {
        state: state
    };
};
var MatchSignal = function (ctx, logger, nk, dispatcher, tick, state, data) {
    return {
        state: state,
        data: data
    };
};
var CreateLobbyMatchRpc = function (ctx, logger, nk, payload) {
    fetch("https://localhost:7152/gameserver", {
        method: "POST",
        cache: "no-cache",
        headers: {
            "Content-Type": "application/json",
        },
        redirect: "follow",
        body: JSON.stringify({ matchId: "300" }),
    });
    var isPrivate = "false";
    var matchName = "Play with ".concat(ctx.username);
    var users = nk.usersGetId([ctx.userId]);
    logger.info(JSON.stringify(users));
    if (payload) {
        var data = JSON.parse(payload);
        if (data.isPrivate) {
            isPrivate = data.isPrivate.toString();
        }
        if (users.length > 0) {
            matchName = "Play with ".concat(users[0].displayName).concat(data.isPrivate ? " (Private)" : "");
        }
    }
    logger.info(payload);
    var matchId = nk.matchCreate("LobbyMatch", { isPrivate: isPrivate, matchName: matchName });
    return JSON.stringify({ matchId: matchId });
};
