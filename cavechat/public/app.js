(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    mode: "login", user: null, communities: [], activeCommunity: null,
    channels: [], activeChannel: null, dms: [], activeDM: null,
    view: "home", socket: null, members: [], toastTimer: null,
    config: null, modalMode: "community", modalTab: "create", searchTimer: null
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const initials = (name) => (name || "?").trim().slice(0, 2).toUpperCase();
  const colorFor = (text) => {
    let hash = 0;
    for (const ch of String(text || "")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${hash} 48% 43%)`;
  };
  function avatar(name, cls = "avatar") {
    const node = el("div", cls, initials(name));
    node.style.background = colorFor(name);
    return node;
  }
  function toast(message) {
    $("toast").textContent = message;
    $("toast").classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3000);
  }
  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function setMode(mode) {
    state.mode = mode;
    const registering = mode === "register";
    $("loginTab").classList.toggle("active", !registering);
    $("registerTab").classList.toggle("active", registering);
    $("authTitle").textContent = registering ? "Create your account" : "Welcome back!";
    $("authSubtitle").textContent = registering ? "Your corner of the internet starts here." : "We're glad to see you again.";
    $("usernameField").classList.toggle("hidden", !registering);
    $("emailField").classList.toggle("hidden", !registering);
    $("identityField").classList.toggle("hidden", registering);
    $("identityInput").required = !registering;
    $("emailInput").required = registering;
    $("usernameInput").required = registering;
    $("authSubmit").textContent = registering ? "Create account" : "Log in";
    $("authError").textContent = "";
    $("passwordInput").autocomplete = registering ? "new-password" : "current-password";
  }
  $("loginTab").addEventListener("click", () => setMode("login"));
  $("registerTab").addEventListener("click", () => setMode("register"));

  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("authSubmit");
    button.disabled = true;
    $("authError").textContent = "";
    try {
      let data;
      if (state.mode === "register") {
        data = await api("/api/auth/register", { method: "POST", body: JSON.stringify({
          username: $("usernameInput").value,
          email: $("emailInput").value,
          password: $("passwordInput").value
        }) });
      } else {
        data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({
          identity: $("identityInput").value,
          password: $("passwordInput").value
        }) });
      }
      await enterApp(data.user);
    } catch (err) {
      $("authError").textContent = err.message;
    } finally { button.disabled = false; }
  });

  async function checkSession() {
    try {
      const data = await api("/api/me");
      await enterApp(data.user);
    } catch { $("authScreen").classList.remove("hidden"); }
  }

  async function enterApp(user) {
    state.user = user;
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("selfName").textContent = user.username;
    $("selfAvatar").textContent = initials(user.username);
    $("selfAvatar").style.background = colorFor(user.username);
    state.config = await api("/api/config").catch(() => ({ gifsEnabled: false, giphyApiKey: "" }));
    connectSocket();
    await Promise.all([loadCommunities(), loadDMs()]);
    openHome();
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ withCredentials: true });
    state.socket.on("connect", () => {
      $("connectionDot").classList.add("online");
      $("connectionText").textContent = "Online";
      if (state.activeChannel) state.socket.emit("channel:join", state.activeChannel.id);
      if (state.activeDM) state.socket.emit("dm:join", state.activeDM.id);
    });
    state.socket.on("disconnect", () => {
      $("connectionDot").classList.remove("online");
      $("connectionText").textContent = "Reconnecting";
    });
    state.socket.on("connect_error", () => {
      $("connectionDot").classList.remove("online");
      $("connectionText").textContent = "Offline";
    });
    state.socket.on("chat:message", (message) => {
      if (message.channelId !== state.activeChannel?.id) return;
      appendMessage(message);
      scrollMessages();
    });
    state.socket.on("dm:message", (message) => {
      if (message.conversationId !== state.activeDM?.id) return;
      appendMessage(message);
      scrollMessages();
      loadDMs().catch(() => {});
    });
    state.socket.on("presence:update", () => {
      if (state.activeCommunity) loadMembers().catch(() => {});
      loadDMs().catch(() => {});
    });
  }

  async function loadCommunities() {
    const data = await api("/api/communities");
    state.communities = data.communities;
    renderRail();
    if (state.activeCommunity) {
      const current = state.communities.find(c => c.id === state.activeCommunity.id);
      if (current) await selectCommunity(current.id, false);
      else state.activeCommunity = null;
    }
  }

  async function loadDMs() {
    const data = await api("/api/dms");
    state.dms = data.dms;
    if (state.view !== "community") renderSidebar();
    renderRail();
  }

  function renderRail() {
    const rail = $("serverRail");
    rail.replaceChildren();
    const home = el("button", `railButton brandRail${state.view !== "community" ? " selected" : ""}`, "C");
    home.title = "Direct messages";
    home.addEventListener("click", openHome);
    rail.append(home, el("div", "railDivider"));
    state.communities.forEach((community) => {
      const button = el("button", `railButton${state.view === "community" && state.activeCommunity?.id === community.id ? " selected" : ""}`, initials(community.name));
      button.title = community.name;
      button.style.background = state.view === "community" && state.activeCommunity?.id === community.id ? "var(--accent)" : colorFor(community.name);
      button.addEventListener("click", () => selectCommunity(community.id));
      rail.append(button);
    });
    rail.append(el("div", "railDivider"));
    const add = el("button", "railButton add", "+");
    add.title = "Create or join a community";
    add.addEventListener("click", openCommunityModal);
    rail.append(add);
  }

  function leaveCurrentRooms() {
    if (state.activeChannel && state.socket?.connected) state.socket.emit("channel:leave", state.activeChannel.id);
    if (state.activeDM && state.socket?.connected) state.socket.emit("dm:leave", state.activeDM.id);
    state.activeChannel = null;
    state.activeDM = null;
  }

  function openHome() {
    leaveCurrentRooms();
    state.view = "home";
    state.activeCommunity = null;
    state.channels = [];
    state.members = [];
    $("communityName").textContent = "Direct Messages";
    $("findPeopleBtn").classList.remove("hidden");
    $("inviteBtn").classList.add("hidden");
    $("membersBtn").classList.add("hidden");
    $("membersPanel").classList.add("hidden");
    $("headerSymbol").textContent = "✉";
    $("headerTitle").textContent = "Direct Messages";
    setComposerEnabled(false);
    $("messageInput").placeholder = "Choose a conversation or find someone";
    renderRail();
    renderSidebar();
    renderWelcome("Your messages", "Pick a conversation on the left, or find someone to start a new one.");
  }

  function renderSidebar() {
    const list = $("channelList");
    list.replaceChildren();
    if (state.view !== "community") {
      const dmHeading = el("div", "sideLabel", "DIRECT MESSAGES");
      const addDM = el("button", "", "+");
      addDM.title = "Find people";
      addDM.addEventListener("click", openFindPeopleModal);
      dmHeading.append(addDM);
      list.append(dmHeading);
      if (!state.dms.length) list.append(el("div", "sidebarHint", "No conversations yet. Use Find People to start one."));
      state.dms.forEach(dm => {
        const row = el("div", `channelItem dmChannel${state.activeDM?.id === dm.id ? " active" : ""}`);
        row.append(avatar(dm.other_username, "avatar tinyAvatar"));
        const label = el("span", "dmLabel", dm.other_username);
        row.append(label);
        if (dm.online) row.append(el("span", "onlineMini"));
        row.addEventListener("click", () => selectDM(dm));
        list.append(row);
      });
      return;
    }
    if (!state.activeCommunity) {
      list.append(el("div", "sidebarHint", "Create a community or join one with an invite code to get started."));
      return;
    }
    const textLabel = el("div", "sideLabel", "TEXT CHANNELS");
    const addText = el("button", "", "+");
    addText.title = "Create text channel";
    addText.addEventListener("click", () => openChannelModal("text"));
    textLabel.append(addText); list.append(textLabel);
    const textChannels = state.channels.filter(c => c.type === "text");
    textChannels.forEach(channel => list.append(channelButton(channel)));
    if (!textChannels.length) list.append(el("div", "sidebarHint", "No text channels yet."));
    const voiceLabel = el("div", "sideLabel", "VOICE CHANNELS");
    const addVoice = el("button", "", "+");
    addVoice.title = "Create voice channel";
    addVoice.addEventListener("click", () => openChannelModal("voice"));
    voiceLabel.append(addVoice); list.append(voiceLabel);
    const voiceChannels = state.channels.filter(c => c.type === "voice");
    voiceChannels.forEach(channel => list.append(channelButton(channel)));
    if (!voiceChannels.length) list.append(el("div", "sidebarHint", "Voice chat isn't wired up yet."));
  }

  function channelButton(channel) {
    const row = el("div", `channelItem${state.activeChannel?.id === channel.id ? " active" : ""}`);
    row.append(el("span", channel.type === "text" ? "hash" : "voiceIcon", channel.type === "text" ? "#" : "◖"));
    row.append(el("span", "", channel.name));
    row.addEventListener("click", () => {
      if (channel.type === "voice") return toast("Voice chat isn't wired up yet.");
      selectChannel(channel.id);
    });
    return row;
  }

  async function selectCommunity(id, load = true) {
    leaveCurrentRooms();
    const community = state.communities.find(c => c.id === id);
    if (!community) return;
    state.view = "community";
    state.activeCommunity = community;
    $("communityName").textContent = community.name;
    $("findPeopleBtn").classList.add("hidden");
    $("inviteBtn").classList.remove("hidden");
    $("membersBtn").classList.remove("hidden");
    $("membersPanel").classList.remove("hidden");
    renderRail();
    if (!load) return;
    try {
      const [channelsData] = await Promise.all([
        api(`/api/communities/${community.id}/channels`),
        loadMembers()
      ]);
      state.channels = channelsData.channels;
      renderSidebar();
      const firstText = state.channels.find(c => c.type === "text");
      if (firstText) await selectChannel(firstText.id);
      else { renderWelcome("No text channels yet", "Create a text channel to start chatting."); setComposerEnabled(false); }
    } catch (err) { toast(err.message); }
  }

  async function selectChannel(id) {
    if (state.activeDM && state.socket?.connected) state.socket.emit("dm:leave", state.activeDM.id);
    state.activeDM = null;
    const channel = state.channels.find(c => c.id === id);
    if (!channel || channel.type !== "text") return;
    if (state.activeChannel && state.socket?.connected) state.socket.emit("channel:leave", state.activeChannel.id);
    state.activeChannel = channel;
    renderSidebar();
    $("headerSymbol").textContent = "#";
    $("headerTitle").textContent = channel.name;
    $("inviteBtn").classList.remove("hidden");
    $("membersBtn").classList.remove("hidden");
    setComposerEnabled(true);
    $("messageInput").placeholder = `Message #${channel.name}`;
    $("messages").replaceChildren(el("div", "emptyChat", "Loading messages…"));
    try {
      const data = await api(`/api/channels/${channel.id}/messages`);
      renderMessages(data.messages, `Welcome to #${channel.name}`);
      if (state.socket?.connected) state.socket.emit("channel:join", channel.id);
    } catch (err) { toast(err.message); }
  }

  async function selectDM(dm) {
    if (state.activeChannel && state.socket?.connected) state.socket.emit("channel:leave", state.activeChannel.id);
    if (state.activeDM && state.socket?.connected) state.socket.emit("dm:leave", state.activeDM.id);
    state.view = "dm";
    state.activeCommunity = null;
    state.activeChannel = null;
    state.activeDM = dm;
    $("communityName").textContent = "Direct Messages";
    $("findPeopleBtn").classList.remove("hidden");
    $("inviteBtn").classList.add("hidden");
    $("membersBtn").classList.add("hidden");
    $("membersPanel").classList.add("hidden");
    $("headerSymbol").textContent = "@";
    $("headerTitle").textContent = dm.other_username;
    $("messageInput").placeholder = `Message @${dm.other_username}`;
    setComposerEnabled(true);
    renderRail();
    renderSidebar();
    $("messages").replaceChildren(el("div", "emptyChat", "Loading messages…"));
    try {
      const data = await api(`/api/dms/${dm.id}/messages`);
      renderMessages(data.messages, `This is the beginning of your conversation with ${dm.other_username}`);
      if (state.socket?.connected) state.socket.emit("dm:join", dm.id);
    } catch (err) { toast(err.message); }
  }

  async function loadMembers() {
    if (!state.activeCommunity) { state.members = []; renderMembers(); return; }
    const data = await api(`/api/communities/${state.activeCommunity.id}/members`);
    state.members = data.members;
    renderMembers();
  }
  function renderMembers() {
    const list = $("memberList");
    list.replaceChildren();
    const online = state.members.filter(m => m.online);
    const offline = state.members.filter(m => !m.online);
    for (const [label, group] of [["ONLINE", online], ["OFFLINE", offline]]) {
      if (!group.length) continue;
      list.append(el("div", "membersHeading", `${label} — ${group.length}`));
      group.forEach(member => {
        const row = el("div", "memberItem");
        row.append(avatar(member.username));
        const info = el("div", "", member.username);
        info.append(el("small", "", member.role === "owner" ? "Community owner" : member.role));
        row.append(info, el("span", `presence${member.online ? " online" : ""}`));
        row.addEventListener("click", () => startDMWith(member.id));
        row.title = "Click to message";
        list.append(row);
      });
    }
    if (!state.members.length) list.append(el("div", "sidebarHint", "No members yet."));
  }

  function renderWelcome(title = "Welcome to CaveChat", subtitle = "Your conversations will show up here.") {
    const wrap = el("div", "welcome");
    wrap.append(el("div", "welcomeIcon", "✦"), el("h2", "", title), el("p", "", subtitle));
    $("messages").replaceChildren(wrap);
    $("headerSymbol").textContent = "✦";
    $("headerTitle").textContent = state.view === "community" && state.activeCommunity ? state.activeCommunity.name : "Direct Messages";
  }

  function renderMessages(messages, emptyTitle) {
    const list = $("messages");
    list.replaceChildren();
    if (!messages.length) {
      const wrap = el("div", "welcome");
      wrap.append(el("div", "welcomeIcon", "✦"), el("h2", "", emptyTitle || "This is the start"), el("p", "", "Send the first message."));
      list.append(wrap);
      return;
    }
    messages.forEach(appendMessage);
    scrollMessages();
  }

  function appendMessage(message) {
    const list = $("messages");
    const row = el("article", "message");
    const name = message.user?.username || "Unknown";
    row.append(avatar(name));
    const body = el("div", "messageBody");
    const meta = el("div", "messageMeta");
    meta.append(el("span", "messageAuthor", name));
    const date = new Date(message.createdAt);
    meta.append(el("span", "messageTime", Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
    body.append(meta);
    if (message.content) body.append(el("div", "messageText", message.content));
    if (message.mediaUrl) {
      const media = el("img", "chatGif");
      media.src = message.mediaUrl;
      media.alt = "GIF";
      media.loading = "lazy";
      body.append(media);
    }
    if (message.fileUrl) {
      const fileWrap = el("div", "fileAttachment");
      if ((message.fileMime || "").startsWith("image/")) {
        const image = el("img", "uploadedImage");
        image.src = message.fileUrl;
        image.alt = message.fileName || "Uploaded image";
        image.loading = "lazy";
        fileWrap.append(image);
      }
      const link = el("a", "fileLink", `↧ ${message.fileName || "Download attachment"}`);
      link.href = message.fileUrl;
      link.target = "_blank";
      link.rel = "noopener";
      fileWrap.append(link);
      body.append(fileWrap);
    }
    row.append(body);
    list.append(row);
  }
  function scrollMessages() { $("messages").scrollTop = $("messages").scrollHeight; }
  function setComposerEnabled(enabled) {
    $("messageInput").disabled = !enabled;
    $("sendBtn").disabled = !enabled;
    $("attachBtn").disabled = !enabled;
    $("gifBtn").disabled = !enabled;
  }

  $("messageForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const content = $("messageInput").value.trim();
    if (!content || !state.socket?.connected) return;
    const callback = (result) => {
      $("sendBtn").disabled = false;
      if (!result?.ok) return toast(result?.error || "Message could not be sent.");
      $("messageInput").value = "";
      $("messageInput").style.height = "auto";
    };
    $("sendBtn").disabled = true;
    if (state.view === "dm" && state.activeDM) {
      state.socket.emit("dm:send", { conversationId: state.activeDM.id, content }, callback);
    } else if (state.view === "community" && state.activeChannel) {
      state.socket.emit("chat:send", { channelId: state.activeChannel.id, content }, callback);
    } else {
      $("sendBtn").disabled = false;
    }
  });
  $("messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); $("messageForm").requestSubmit();
    }
  });
  $("messageInput").addEventListener("input", () => {
    $("messageInput").style.height = "auto";
    $("messageInput").style.height = `${Math.min($("messageInput").scrollHeight, 150)}px`;
  });

  async function sendMedia(url) {
    if (!state.socket?.connected) return toast("You're reconnecting. Try again in a moment.");
    const callback = (result) => {
      if (!result?.ok) toast(result?.error || "GIF could not be sent.");
    };
    if (state.view === "dm" && state.activeDM) {
      state.socket.emit("dm:send", { conversationId: state.activeDM.id, mediaUrl: url }, callback);
    } else if (state.view === "community" && state.activeChannel) {
      state.socket.emit("chat:send", { channelId: state.activeChannel.id, mediaUrl: url }, callback);
    }
  }

  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async () => {
    const file = $("fileInput").files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast("Files must be 8 MB or smaller."); $("fileInput").value = ""; return; }
    const form = new FormData();
    form.append("file", file);
    try {
      const endpoint = state.view === "dm" && state.activeDM
        ? `/api/dms/${state.activeDM.id}/upload`
        : state.activeChannel ? `/api/channels/${state.activeChannel.id}/upload` : null;
      if (!endpoint) throw new Error("Select a chat before uploading.");
      await api(endpoint, { method: "POST", body: form });
      toast("File uploaded!");
    } catch (err) { toast(err.message); }
    finally { $("fileInput").value = ""; }
  });

  function openCommunityModal() {
    state.modalMode = "community"; state.modalTab = "create";
    $("modalSubmit").classList.remove("hidden");
    $("modalTitle").textContent = "Create or join a community";
    $("modalDescription").textContent = "Build a place for your people, or join with an invite code.";
    $("modalBody").innerHTML = `
      <div class="modalTabs"><button type="button" data-tab="create" class="active">Create</button><button type="button" data-tab="join">Join</button></div>
      <div id="createCommunityPane"><label class="field"><span>Community name</span><input id="communityNameInput" maxlength="80" placeholder="The cool people club"></label></div>
      <div id="joinCommunityPane" class="hidden"><label class="field"><span>Invite code</span><input id="inviteCodeInput" maxlength="32" placeholder="Paste an invite code"></label></div>
      <div id="modalError" class="modalError"></div>`;
    $("modalBody").querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => {
      state.modalTab = button.dataset.tab;
      $("modalBody").querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b === button));
      $("createCommunityPane").classList.toggle("hidden", state.modalTab !== "create");
      $("joinCommunityPane").classList.toggle("hidden", state.modalTab !== "join");
      $("modalSubmit").textContent = state.modalTab === "create" ? "Create community" : "Join community";
      $("modalError").textContent = "";
    }));
    $("modalSubmit").textContent = "Create community";
    showModal();
  }

  function openChannelModal(type) {
    state.modalMode = "channel";
    $("modalSubmit").classList.remove("hidden");
    $("modalTitle").textContent = `Create a ${type} channel`;
    $("modalDescription").textContent = `Add a new ${type} channel to ${state.activeCommunity.name}.`;
    $("modalBody").innerHTML = `<label class="field"><span>Channel name</span><input id="channelNameInput" maxlength="80" placeholder="${type === "text" ? "new-chat" : "hangout"}"></label><div class="modalError" id="modalError"></div>`;
    $("modalSubmit").textContent = "Create channel";
    $("modalSubmit").dataset.type = type;
    showModal();
  }

  function openFindPeopleModal() {
    state.modalMode = "findPeople";
    $("modalTitle").textContent = "Find people";
    $("modalDescription").textContent = "Search CaveChat usernames and start a direct conversation.";
    $("modalBody").innerHTML = `
      <label class="field"><span>Search usernames</span><input id="peopleSearchInput" maxlength="24" placeholder="Type at least 2 characters" autocomplete="off"></label>
      <div id="peopleResults" class="searchResults"><div class="sidebarHint">Search by username. Email addresses are never shown.</div></div>`;
    $("modalSubmit").classList.add("hidden");
    showModal();
    $("peopleSearchInput").addEventListener("input", () => {
      clearTimeout(state.searchTimer);
      const query = $("peopleSearchInput").value.trim();
      if (query.length < 2) { $("peopleResults").replaceChildren(el("div", "sidebarHint", "Type at least 2 characters.")); return; }
      state.searchTimer = setTimeout(() => searchPeople(query), 220);
    });
    setTimeout(() => $("peopleSearchInput").focus(), 30);
  }

  async function searchPeople(query) {
    try {
      const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
      const results = $("peopleResults");
      results.replaceChildren();
      if (!data.users.length) { results.append(el("div", "sidebarHint", "No matching accounts found.")); return; }
      data.users.forEach(user => {
        const row = el("button", "searchUser");
        row.append(avatar(user.username));
        const details = el("span", "searchUserDetails", user.username);
        details.append(el("small", "", user.online ? "Online" : "Offline"));
        row.append(details, el("span", "searchStart", "Message"));
        row.addEventListener("click", () => startDMWith(user.id));
        results.append(row);
      });
    } catch (err) { toast(err.message); }
  }

  async function startDMWith(userId) {
    try {
      const data = await api(`/api/dms/${userId}`, { method: "POST" });
      closeModal();
      await loadDMs();
      const dm = state.dms.find(item => item.id === data.conversation.id) || data.conversation;
      await selectDM(dm);
    } catch (err) { toast(err.message); }
  }

  async function openGifPicker() {
    state.modalMode = "gif";
    $("modalTitle").textContent = "Choose a GIF";
    $("modalDescription").textContent = "Search for a reaction to send in chat.";
    if (!state.config?.gifsEnabled || !state.config.giphyApiKey) {
      $("modalBody").innerHTML = `<div class="gifSetup"><strong>GIF search needs a GIPHY API key.</strong><p>Create an API key at <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noopener">GIPHY Developers</a>, then add it to Render as <code>GIPHY_API_KEY</code> and redeploy.</p></div>`;
      $("modalSubmit").classList.add("hidden");
      showModal();
      return;
    }
    $("modalBody").innerHTML = `
      <div class="gifSearchRow"><input id="gifSearchInput" placeholder="Search GIFs…" maxlength="80"><button id="gifSearchButton" type="button">Search</button></div>
      <div id="gifResults" class="gifGrid"><div class="sidebarHint">Search for something like “happy”, “bruh”, or “wow”.</div></div>
      <div class="giphyCredit">Powered by GIPHY</div>`;
    $("modalSubmit").classList.add("hidden");
    showModal();
    const runSearch = () => searchGifs($("gifSearchInput").value.trim());
    $("gifSearchButton").addEventListener("click", runSearch);
    $("gifSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
    $("gifSearchInput").focus();
  }

  async function searchGifs(query) {
    if (!query) return;
    const results = $("gifResults");
    results.replaceChildren(el("div", "sidebarHint", "Searching…"));
    try {
      const url = new URL("https://api.giphy.com/v1/gifs/search");
      url.searchParams.set("api_key", state.config.giphyApiKey);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "24");
      url.searchParams.set("rating", "g");
      url.searchParams.set("lang", "en");
      const response = await fetch(url);
      if (!response.ok) throw new Error("GIPHY search failed. Check the API key in Render.");
      const data = await response.json();
      results.replaceChildren();
      const gifs = (data.data || []).filter(gif => gif.images?.fixed_width?.url && gif.images?.original?.url);
      if (!gifs.length) { results.append(el("div", "sidebarHint", "No GIFs found. Try another search.")); return; }
      gifs.forEach(gif => {
        const button = el("button", "gifChoice");
        const img = el("img"); img.src = gif.images.fixed_width.url; img.alt = gif.title || "GIF"; img.loading = "lazy";
        button.append(img);
        button.addEventListener("click", async () => { await sendMedia(gif.images.original.url); closeModal(); });
        results.append(button);
      });
    } catch (err) {
      results.replaceChildren(el("div", "sidebarHint", err.message));
    }
  }

  function showModal() {
    $("modalBack").classList.remove("hidden");
    setTimeout(() => $("modalBody").querySelector("input")?.focus(), 30);
  }
  function closeModal() {
    $("modalBack").classList.add("hidden");
    $("modalSubmit").dataset.type = "";
    $("modalSubmit").classList.remove("hidden");
  }
  $("modalCancel").addEventListener("click", closeModal);
  $("modalBack").addEventListener("click", (event) => { if (event.target === $("modalBack")) closeModal(); });

  $("modalSubmit").addEventListener("click", async () => {
    const button = $("modalSubmit");
    button.disabled = true;
    const error = $("modalError");
    if (error) error.textContent = "";
    try {
      if (state.modalMode === "community" && state.modalTab === "create") {
        const created = await api("/api/communities", { method: "POST", body: JSON.stringify({ name: $("communityNameInput").value }) });
        closeModal(); await loadCommunities(); await selectCommunity(created.community.id); toast("Community created!");
      } else if (state.modalMode === "community") {
        const joined = await api(`/api/join/${encodeURIComponent($("inviteCodeInput").value.trim())}`, { method: "POST" });
        closeModal(); await loadCommunities(); await selectCommunity(joined.community.id); toast("You joined the community!");
      } else if (state.modalMode === "channel") {
        const channelType = button.dataset.type;
        await api(`/api/communities/${state.activeCommunity.id}/channels`, { method: "POST", body: JSON.stringify({ name: $("channelNameInput").value, type: channelType }) });
        closeModal();
        const result = await api(`/api/communities/${state.activeCommunity.id}/channels`);
        state.channels = result.channels; renderSidebar();
        const newest = [...state.channels].reverse().find(c => c.type === channelType);
        if (newest?.type === "text") await selectChannel(newest.id);
        toast("Channel created!");
      }
    } catch (err) {
      if (error) error.textContent = err.message;
      else toast(err.message);
    } finally { button.disabled = false; }
  });

  async function getInviteCode() {
    if (!state.activeCommunity) return;
    try {
      const data = await api(`/api/communities/${state.activeCommunity.id}/invite`, { method: "POST" });
      await navigator.clipboard.writeText(data.inviteCode);
      toast(`Invite code copied: ${data.inviteCode}`);
    } catch (err) { toast(err.message || "Couldn't copy invite code."); }
  }
  $("inviteBtn").addEventListener("click", getInviteCode);
  $("findPeopleBtn").addEventListener("click", openFindPeopleModal);
  $("findPeopleHeader").addEventListener("click", openFindPeopleModal);
  $("membersBtn").addEventListener("click", () => $("membersPanel").classList.toggle("hidden"));
  $("gifBtn").addEventListener("click", openGifPicker);
  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    state.socket?.disconnect();
    state.user = null; state.activeCommunity = null; state.activeChannel = null; state.activeDM = null;
    $("app").classList.add("hidden"); $("authScreen").classList.remove("hidden"); $("passwordInput").value = "";
    setMode("login");
  });

  setMode("login");
  checkSession().catch((err) => { $("authScreen").classList.remove("hidden"); $("authError").textContent = err.message; });
})();
