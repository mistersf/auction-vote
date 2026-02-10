let ws = null;
let playerId = null;
let room = null;
let lastWinners = null;

const joinView = document.querySelector("#joinView");
const appView = document.querySelector("#appView");

const roomInput = document.querySelector("#roomInput");
const nameInput = document.querySelector("#nameInput");
const joinBtn = document.querySelector("#joinBtn");

const roomLabel = document.querySelector("#roomLabel");
const hostBadge = document.querySelector("#hostBadge");
const lockBadge = document.querySelector("#lockBadge");

const budgetLabel = document.querySelector("#budgetLabel");
const spentLabel = document.querySelector("#spentLabel");
const remainingLabel = document.querySelector("#remainingLabel");

const hostPanel = document.querySelector("#hostPanel");
const topicEditor = document.querySelector("#topicEditor");

const budgetInput = document.querySelector("#budgetInput");
const revealBidsInput = document.querySelector("#revealBidsInput");
const allowJoinAfterLockInput = document.querySelector("#allowJoinAfterLockInput");
const saveConfigBtn = document.querySelector("#saveConfigBtn");
const lockBtn = document.querySelector("#lockBtn");
const unlockBtn = document.querySelector("#unlockBtn");
const computeBtn = document.querySelector("#computeBtn");

const topicsEl = document.querySelector("#topics");
const playersEl = document.querySelector("#players");
const resultsEl = document.querySelector("#results");

const topicRowsEl = document.querySelector("#topicRows");
const addTopicBtn = document.querySelector("#addTopicBtn");
const saveTopicsBtn = document.querySelector("#saveTopicsBtn");

function connect() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	ws = new WebSocket(`${proto}://${location.host}`);

	ws.addEventListener("message", (ev) => {
		const msg = JSON.parse(ev.data);

		if (msg.type === "error") {
			alert(msg.message);
			return;
		}

		if (msg.type === "joined") {
			playerId = msg.playerId;
			room = msg.room;
			lastWinners = null;
			showApp();
			render();
			return;
		}

		if (msg.type === "room_update") {
			room = msg.room;
			render();
			return;
		}

		if (msg.type === "winners") {
			lastWinners = msg.winners;
			renderResults();
			return;
		}
	});

	ws.addEventListener("close", () => {
		alert("Disconnected. Refresh to rejoin.");
	});
}

function send(msg) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify(msg));
}

function showApp() {
	joinView.classList.add("hidden");
	appView.classList.remove("hidden");
	roomLabel.textContent = room.id;
}

function isHost() {
	return room && playerId && room.hostId === playerId;
}

function myPlayer() {
	return room.players.find(p => p.id === playerId) || null;
}

function myBidAmount(topicId) {
	if (!room.bids) return 0;
	const mine = room.bids[playerId] || {};
	return Math.floor(mine[topicId]?.amount ?? 0);
}

function render() {
	if (!room) return;

	const me = myPlayer();
	const budget = room.config.budget;
	const spent = me ? me.spent : 0;
	const remaining = Math.max(0, budget - spent);

	budgetLabel.textContent = String(budget);
	spentLabel.textContent = String(spent);
	remainingLabel.textContent = String(remaining);

	hostBadge.classList.toggle("hidden", !isHost());
	lockBadge.classList.toggle("hidden", !room.locked);

	hostPanel.classList.toggle("hidden", !isHost());
	topicEditor.classList.toggle("hidden", !isHost());

	if (isHost()) {
		budgetInput.value = room.config.budget;
		revealBidsInput.checked = !!room.config.revealBids;
		allowJoinAfterLockInput.checked = !!room.config.allowJoinAfterLock;
	}

	renderTopics();
	renderPlayers();
	renderResults();
	renderTopicEditor();
}

function renderTopics() {
	topicsEl.innerHTML = "";

	if (!room.topics.length) {
		topicsEl.innerHTML = `<p class="hint">No topics yet. Host should add some.</p>`;
		return;
	}

	for (const t of room.topics) {
		const card = document.createElement("div");
		card.className = "topicCard";

		const header = document.createElement("div");
		header.className = "topicHeader";

		const left = document.createElement("div");
		left.innerHTML = `
			<div class="topicName">${escapeHtml(t.name)}</div>
			<div class="small">Capacity: ${t.capacity}</div>
		`;

		header.appendChild(left);
		card.appendChild(header);

		const bidRow = document.createElement("div");
		bidRow.className = "bidRow";

		const bid = myBidAmount(t.id);

		const range = document.createElement("input");
		range.type = "range";
		range.min = "0";
		range.max = String(room.config.budget);
		range.step = "1";
		range.value = String(bid);
		range.disabled = room.locked;

		const number = document.createElement("input");
		number.type = "number";
		number.min = "0";
		number.max = String(room.config.budget);
		number.step = "1";
		number.value = String(bid);
		number.disabled = room.locked;

		const sync = (val) => {
			const v = clampInt(val, 0, room.config.budget);
			range.value = String(v);
			number.value = String(v);
			send({ type: "bid", topicId: t.id, amount: v });
		};

		range.addEventListener("input", () => sync(range.value));
		number.addEventListener("change", () => sync(number.value));

		bidRow.appendChild(document.createTextNode("Your bid: "));
		bidRow.appendChild(range);
		bidRow.appendChild(number);

		card.appendChild(bidRow);

		// If bids are revealed, show top bidders preview
		if (room.bids && room.config.revealBids) {
			const all = [];
			for (const p of room.players) {
				const amt = Math.floor(room.bids[p.id]?.[t.id]?.amount ?? 0);
				if (amt > 0) all.push({ name: p.name, amt });
			}
			all.sort((a, b) => b.amt - a.amt);

			const preview = document.createElement("div");
			preview.className = "small";
			preview.style.marginTop = "10px";
			preview.textContent = all.length
				? `Top bids: ${all.slice(0, 5).map(x => `${x.name} (${x.amt})`).join(", ")}`
				: `No bids yet.`;

			card.appendChild(preview);
		}

		topicsEl.appendChild(card);
	}
}

function renderPlayers() {
	playersEl.innerHTML = "";

	const ul = document.createElement("div");
	ul.className = "mono";

	const lines = [];
	for (const p of room.players) {
		const tag = p.id === room.hostId ? " (host)" : "";
		lines.push(`${p.name}${tag} — spent ${p.spent}/${room.config.budget}`);
	}
	ul.textContent = lines.join("\n");

	playersEl.appendChild(ul);
}

function renderResults() {
	if (!lastWinners) {
		resultsEl.textContent = "No results yet.";
		return;
	}

	const topicName = new Map(room.topics.map(t => [t.id, t.name]));
	const playerName = new Map(room.players.map(p => [p.id, p.name]));

	let out = "";

	// Per player assignment
	out += "Assignments (one topic max per player):\n";
	const entries = Object.entries(lastWinners.assignmentByPlayer);
	entries.sort((a, b) => (playerName.get(a[0]) || a[0]).localeCompare(playerName.get(b[0]) || b[0]));
	for (const [pid, tid] of entries) {
		out += `- ${playerName.get(pid) || pid} -> ${topicName.get(tid) || tid}\n`;
	}

	out += "\nWinners by topic:\n";
	for (const t of room.topics) {
		const winners = lastWinners.winnersByTopic[t.id] || [];
		out += `\n${t.name} (capacity ${t.capacity}):\n`;
		if (!winners.length) out += "  (no winners)\n";
		for (const pid of winners) {
			out += `  - ${playerName.get(pid) || pid}\n`;
		}
	}

	resultsEl.textContent = out.trim();
}

function renderTopicEditor() {
	if (!isHost()) return;

	topicRowsEl.innerHTML = "";
	const topics = room.topics.length ? room.topics : [
		{ id: cryptoId(), name: "Topic A", capacity: 1 },
		{ id: cryptoId(), name: "Topic B", capacity: 1 }
	];

	for (const t of topics) {
		const row = document.createElement("div");
		row.className = "row";
		row.style.marginBottom = "10px";

		const name = document.createElement("input");
		name.value = t.name;
		name.placeholder = "Topic name";

		const cap = document.createElement("input");
		cap.type = "number";
		cap.min = "1";
		cap.max = "20";
		cap.step = "1";
		cap.value = String(t.capacity);

		const del = document.createElement("button");
		del.className = "ghost";
		del.textContent = "Delete";
		del.addEventListener("click", () => {
			row.remove();
		});

		row.dataset.topicId = t.id;
		row.appendChild(name);
		row.appendChild(cap);
		row.appendChild(del);

		topicRowsEl.appendChild(row);
	}
}

function collectTopicsFromEditor() {
	const rows = [...topicRowsEl.querySelectorAll(".row")];
	return rows.map(r => {
		const inputs = r.querySelectorAll("input");
		const name = inputs[0].value.trim();
		const cap = clampInt(inputs[1].value, 1, 20);
		return { id: r.dataset.topicId || cryptoId(), name, capacity: cap };
	}).filter(t => t.name.length);
}

joinBtn.addEventListener("click", () => {
	const roomId = roomInput.value.trim().toUpperCase();
	const name = nameInput.value.trim();
	if (!roomId || !name) {
		alert("Room code and name required.");
		return;
	}
	connect();
	ws.addEventListener("open", () => {
		send({ type: "join", roomId, name });
	});
});

saveConfigBtn.addEventListener("click", () => {
	send({
		type: "set_config",
		budget: clampInt(budgetInput.value, 1, 10000),
		revealBids: !!revealBidsInput.checked,
		allowJoinAfterLock: !!allowJoinAfterLockInput.checked
	});
});

lockBtn.addEventListener("click", () => send({ type: "lock_bids" }));
unlockBtn.addEventListener("click", () => send({ type: "unlock_bids" }));
computeBtn.addEventListener("click", () => send({ type: "compute_winners" }));

addTopicBtn.addEventListener("click", () => {
	const row = document.createElement("div");
	row.className = "row";
	row.style.marginBottom = "10px";
	row.dataset.topicId = cryptoId();

	const name = document.createElement("input");
	name.placeholder = "Topic name";

	const cap = document.createElement("input");
	cap.type = "number";
	cap.min = "1";
	cap.max = "20";
	cap.step = "1";
	cap.value = "1";

	const del = document.createElement("button");
	del.className = "ghost";
	del.textContent = "Delete";
	del.addEventListener("click", () => row.remove());

	row.appendChild(name);
	row.appendChild(cap);
	row.appendChild(del);

	topicRowsEl.appendChild(row);
});

saveTopicsBtn.addEventListener("click", () => {
	const topics = collectTopicsFromEditor();
	send({ type: "set_topics", topics });
});

function clampInt(v, min, max) {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function cryptoId() {
	// Good enough for client-side IDs.
	return Math.random().toString(16).slice(2, 8);
}
