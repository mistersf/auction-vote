import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * In-memory rooms.
 * For classroom use this is usually fine.
 * If you want persistence/restarts, you’d store rooms in Redis/DB.
 */
const rooms = new Map();

/**
 * Room state shape:
 * {
 *		id,
 *		hostId,
 *		config: { budget, revealBids, allowJoinAfterLock },
 *		locked: false,
 *		topics: [{ id, name, capacity }],
 *		players: Map(playerId -> { id, name, spent }),
 *		bids: Map(playerId -> Map(topicId -> { amount, ts }))
 * }
 */

function getOrCreateRoom(roomId) {
	let room = rooms.get(roomId);
	if (!room) {
		room = {
			id: roomId,
			hostId: null,
			config: {
				budget: 100,
				revealBids: true,
				allowJoinAfterLock: true
			},
			locked: false,
			topics: [],
			players: new Map(),
			bids: new Map()
		};
		rooms.set(roomId, room);
	}
	return room;
}

function wsSend(ws, msg) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
	for (const p of room.players.values()) {
		if (p.ws && p.ws.readyState === p.ws.OPEN) {
			wsSend(p.ws, msg);
		}
	}
}

function roomSnapshot(room) {
	// Only expose what clients need.
	const players = [...room.players.values()].map(p => ({
		id: p.id,
		name: p.name,
		spent: p.spent
	}));

	const topics = room.topics.map(t => ({ ...t }));

	// Optionally hide per-topic bids until reveal.
	let bids = {};
	for (const [playerId, perTopic] of room.bids.entries()) {
		bids[playerId] = {};
		for (const [topicId, b] of perTopic.entries()) {
			bids[playerId][topicId] = { amount: b.amount, ts: b.ts };
		}
	}

	return {
		id: room.id,
		hostId: room.hostId,
		config: room.config,
		locked: room.locked,
		topics,
		players,
		bids,
		revealBids: room.config.revealBids
	};
}

function recomputeSpent(room, playerId) {
	const perTopic = room.bids.get(playerId);
	let spent = 0;
	if (perTopic) {
		for (const b of perTopic.values()) spent += b.amount;
	}
	const player = room.players.get(playerId);
	if (player) player.spent = spent;
	return spent;
}

/**
 * Allocation rule:
 * - Each topic has capacity N.
 * - “Tentative winners” per topic are highest bids.
 * - If a player is a winner in multiple topics, they keep ONLY the topic they bid highest on.
 * - Vacated slots get filled by next highest bidders (who aren’t already assigned elsewhere).
 *
 * This implements what you described in a deterministic way.
 */
function computeWinners(room) {
	const topics = room.topics;
	const budget = room.config.budget;

	// Build sorted bid lists per topic.
	const bidLists = new Map(); // topicId -> [{ playerId, amount, ts }]
	for (const t of topics) {
		const list = [];
		for (const [playerId, perTopic] of room.bids.entries()) {
			const b = perTopic.get(t.id);
			if (!b) continue;
			const amount = Math.max(0, Math.floor(b.amount));
			if (amount <= 0) continue;

			// (Server already enforces budget by total, but keep this safe.)
			list.push({ playerId, amount, ts: b.ts ?? Date.now() });
		}

		list.sort((a, b) => {
			if (b.amount !== a.amount) return b.amount - a.amount; // higher first
			if (a.ts !== b.ts) return a.ts - b.ts; // earlier first
			return a.playerId.localeCompare(b.playerId);
		});

		bidLists.set(t.id, list);
	}

	// Track assignment.
	const assignedTopicByPlayer = new Map(); // playerId -> topicId
	const assignedBidByPlayer = new Map(); // playerId -> amount
	const winnersByTopic = new Map(); // topicId -> Set(playerId)
	const nextIndex = new Map(); // topicId -> pointer in bid list

	for (const t of topics) {
		winnersByTopic.set(t.id, new Set());
		nextIndex.set(t.id, 0);
	}

	function tryFillTopic(topic) {
		const winners = winnersByTopic.get(topic.id);
		const list = bidLists.get(topic.id) ?? [];
		let idx = nextIndex.get(topic.id) ?? 0;

		while (winners.size < topic.capacity && idx < list.length) {
			const cand = list[idx++];
			const alreadyAssigned = assignedTopicByPlayer.has(cand.playerId);

			if (!alreadyAssigned) {
				winners.add(cand.playerId);
				assignedTopicByPlayer.set(cand.playerId, topic.id);
				assignedBidByPlayer.set(cand.playerId, cand.amount);
			} else {
				// They’re assigned elsewhere; skip for now.
			}
		}

		nextIndex.set(topic.id, idx);
	}

	// First pass: fill each topic up to capacity without considering multi-wins (we avoided multi-wins by skipping already assigned).
	// But this doesn’t match your “they could win multiple, then keep highest” rule.
	// So we instead do a two-stage:
	// 1) Tentatively take top N per topic ignoring duplicates.
	// 2) Resolve duplicates by keeping highest per player, then refill vacancies, repeat.

	// Step 1: Tentative winners per topic (allow duplicates across topics).
	for (const t of topics) {
		const list = bidLists.get(t.id) ?? [];
		const winners = winnersByTopic.get(t.id);
		for (let i = 0; i < Math.min(t.capacity, list.length); i++) {
			winners.add(list[i].playerId);
		}
		nextIndex.set(t.id, Math.min(t.capacity, list.length));
	}

	// Helper: build player -> topics they are currently winning, with amounts.
	function buildPlayerWins() {
		const playerWins = new Map(); // playerId -> [{ topicId, amount, ts }]
		for (const t of topics) {
			const list = bidLists.get(t.id) ?? [];
			const winners = winnersByTopic.get(t.id);

			// Make a quick lookup for amount/ts by player for this topic from list.
			const byPlayer = new Map();
			for (const b of list) {
				if (!byPlayer.has(b.playerId)) byPlayer.set(b.playerId, b);
			}

			for (const playerId of winners) {
				const b = byPlayer.get(playerId);
				if (!b) continue;
				if (!playerWins.has(playerId)) playerWins.set(playerId, []);
				playerWins.get(playerId).push({ topicId: t.id, amount: b.amount, ts: b.ts });
			}
		}
		return playerWins;
	}

	// Step 2: Resolve duplicates iteratively and refill vacancies.
	let changed = true;
	let safety = 0;

	while (changed && safety++ < 1000) {
		changed = false;

		// Decide final assignment for each player who is currently winning 2+ topics.
		const playerWins = buildPlayerWins();
		const keepByPlayer = new Map();

		for (const [playerId, wins] of playerWins.entries()) {
			if (wins.length <= 1) continue;

			wins.sort((a, b) => {
				if (b.amount !== a.amount) return b.amount - a.amount; // highest bid kept
				if (a.ts !== b.ts) return a.ts - b.ts; // earlier kept
				return a.topicId.localeCompare(b.topicId);
			});

			keepByPlayer.set(playerId, wins[0].topicId);
		}

		// Remove player from topics they shouldn't keep.
		for (const [playerId, keepTopicId] of keepByPlayer.entries()) {
			for (const t of topics) {
				const winners = winnersByTopic.get(t.id);
				if (!winners.has(playerId)) continue;
				if (t.id === keepTopicId) continue;

				winners.delete(playerId);
				changed = true;
			}
		}

		// Refill any topics that now have vacancies with next highest bidders
		// who are NOT already winning any topic.
		// First figure out who is already winning something.
		const winningPlayers = new Set();
		for (const t of topics) {
			for (const pid of winnersByTopic.get(t.id)) winningPlayers.add(pid);
		}

		for (const t of topics) {
			const winners = winnersByTopic.get(t.id);
			if (winners.size >= t.capacity) continue;

			const list = bidLists.get(t.id) ?? [];
			let idx = nextIndex.get(t.id) ?? 0;

			while (winners.size < t.capacity && idx < list.length) {
				const cand = list[idx++];
				if (winners.has(cand.playerId)) continue;
				if (winningPlayers.has(cand.playerId)) continue;

				winners.add(cand.playerId);
				winningPlayers.add(cand.playerId);
				changed = true;
			}

			nextIndex.set(t.id, idx);
		}
	}

	// Build output
	const result = {
		winnersByTopic: {},
		assignmentByPlayer: {} // playerId -> topicId
	};

	for (const t of topics) {
		result.winnersByTopic[t.id] = [...winnersByTopic.get(t.id)];
	}

	// assignmentByPlayer (invert)
	for (const t of topics) {
		for (const pid of winnersByTopic.get(t.id)) {
			result.assignmentByPlayer[pid] = t.id;
		}
	}

	return result;
}

wss.on("connection", (ws) => {
	const playerId = nanoid(8);
	let room = null;

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "join") {
			const roomId = String(msg.roomId ?? "").trim().toUpperCase();
			const name = String(msg.name ?? "Player").trim().slice(0, 32) || "Player";

			if (!roomId) {
				wsSend(ws, { type: "error", message: "Room code required." });
				return;
			}

			room = getOrCreateRoom(roomId);

			if (room.locked && !room.config.allowJoinAfterLock) {
				wsSend(ws, { type: "error", message: "Room is locked." });
				return;
			}

			// First person becomes host.
			if (!room.hostId) room.hostId = playerId;

			room.players.set(playerId, { id: playerId, name, spent: 0, ws });
			if (!room.bids.has(playerId)) room.bids.set(playerId, new Map());

			recomputeSpent(room, playerId);

			wsSend(ws, { type: "joined", playerId, room: roomSnapshot(room) });
			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		// Ignore other messages until joined.
		if (!room || !room.players.has(playerId)) return;

		const isHost = room.hostId === playerId;

		if (msg.type === "set_config" && isHost) {
			const budget = Math.max(1, Math.min(10000, Math.floor(msg.budget ?? room.config.budget)));
			room.config.budget = budget;

			if (typeof msg.revealBids === "boolean") room.config.revealBids = msg.revealBids;
			if (typeof msg.allowJoinAfterLock === "boolean") room.config.allowJoinAfterLock = msg.allowJoinAfterLock;

			// Budget change can invalidate bids; clamp.
			for (const pid of room.players.keys()) {
				clampBidsToBudget(room, pid);
			}

			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		if (msg.type === "set_topics" && isHost) {
			const topicsRaw = Array.isArray(msg.topics) ? msg.topics : [];
			room.topics = topicsRaw.slice(0, 50).map(t => ({
				id: String(t.id ?? nanoid(6)),
				name: String(t.name ?? "Topic").trim().slice(0, 80) || "Topic",
				capacity: Math.max(1, Math.min(20, Math.floor(t.capacity ?? 1)))
			}));

			// Remove bids on deleted topics.
			const topicIds = new Set(room.topics.map(t => t.id));
			for (const [pid, perTopic] of room.bids.entries()) {
				for (const tid of [...perTopic.keys()]) {
					if (!topicIds.has(tid)) perTopic.delete(tid);
				}
				recomputeSpent(room, pid);
				clampBidsToBudget(room, pid);
			}

			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		if (msg.type === "lock_bids" && isHost) {
			room.locked = true;
			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		if (msg.type === "unlock_bids" && isHost) {
			room.locked = false;
			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		if (msg.type === "bid" && !room.locked) {
			const topicId = String(msg.topicId ?? "");
			const amount = Math.max(0, Math.floor(Number(msg.amount ?? 0)));

			// Ensure topic exists
			if (!room.topics.some(t => t.id === topicId)) return;

			const perTopic = room.bids.get(playerId) ?? new Map();
			perTopic.set(topicId, { amount, ts: Date.now() });
			room.bids.set(playerId, perTopic);

			// Enforce budget by clamping this player's bids.
			clampBidsToBudget(room, playerId);

			broadcast(room, { type: "room_update", room: roomSnapshot(room) });
			return;
		}

		if (msg.type === "compute_winners" && isHost) {
			const winners = computeWinners(room);
			broadcast(room, { type: "winners", winners });
			return;
		}
	});

	ws.on("close", () => {
		if (!room) return;
		const p = room.players.get(playerId);
		if (p) {
			room.players.delete(playerId);
			// keep bids in case they reconnect? For now, remove.
			room.bids.delete(playerId);

			// If host left, pick a new host.
			if (room.hostId === playerId) {
				const next = room.players.keys().next().value ?? null;
				room.hostId = next;
			}

			// Clean up empty rooms.
			if (room.players.size === 0) rooms.delete(room.id);
			else broadcast(room, { type: "room_update", room: roomSnapshot(room) });
		}
	});
});

function clampBidsToBudget(room, playerId) {
	const budget = room.config.budget;
	const perTopic = room.bids.get(playerId);
	if (!perTopic) return;

	// If over budget, reduce bids starting from smallest (least important).
	// This is a policy choice; you could also reject the last change instead.
	const entries = [...perTopic.entries()].map(([topicId, b]) => ({
		topicId,
		amount: Math.max(0, Math.floor(b.amount)),
		ts: b.ts ?? Date.now()
	}));

	let total = entries.reduce((s, e) => s + e.amount, 0);
	if (total <= budget) {
		recomputeSpent(room, playerId);
		return;
	}

	// Sort ascending by amount, then newest first (so recent tweaks get trimmed slightly earlier)
	entries.sort((a, b) => {
		if (a.amount !== b.amount) return a.amount - b.amount;
		return b.ts - a.ts;
	});

	let over = total - budget;
	for (const e of entries) {
		if (over <= 0) break;
		if (e.amount <= 0) continue;

		const take = Math.min(e.amount, over);
		e.amount -= take;
		over -= take;
	}

	// Write back
	const newMap = new Map();
	for (const e of entries) newMap.set(e.topicId, { amount: e.amount, ts: Date.now() });
	room.bids.set(playerId, newMap);
	recomputeSpent(room, playerId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
