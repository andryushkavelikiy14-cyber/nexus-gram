// ============ CONFIG ============
const API = '';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// ============ STATE ============
let currentUser = null;
let currentToken = null;
let currentChatId = null;
let currentChat = null;
let ws = null;
let chats = [];
let replyingTo = null;
let editingMsgId = null;
let selectedMessage = null;
let selectedAdminUser = null;
let pendingPhoto = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingStartTime = 0;
let voicePlayer = new Audio();
let currentPlayingId = null;
let pendingTwoFA = null;
let rawAvatarData = null;
let avatarRotation = 0;
let avatarTarget = null;

// ============ HELPERS ============
const $ = id => document.getElementById(id);

const api = async (url, opts) => {
  const res = await fetch(API + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || 'Ошибка');
  return data;
};

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function linkify(text) {
  const escaped = escapeHtml(text);
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return escaped.replace(urlRegex, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a>`
  );
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function renderAvatar(el, avatar, fallback) {
  if (!el) return;
  if (avatar && avatar.startsWith('data:image')) {
    el.style.backgroundImage = '';
    el.style.background = `url(${avatar}) center/cover`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.background = 'linear-gradient(135deg, #6366f1, #8b5cf6)';
    el.textContent = (fallback || '?')[0].toUpperCase();
  }
}

// ============ TABS ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.tab + 'Form').classList.add('active');
    $('loginError').textContent = '';
    $('registerError').textContent = '';
  };
});

// ============ AVATAR PREVIEW ============
function openAvatarPreview(dataUrl, target) {
  rawAvatarData = dataUrl;
  avatarRotation = 0;
  avatarTarget = target;
  renderAvatarCrop();
  $('avatarCropModal').classList.remove('hidden');
}

function renderAvatarCrop() {
  const el = $('avatarCropCircle');
  if (!rawAvatarData) { el.style.backgroundImage = ''; el.textContent = '?'; return; }
  el.textContent = '';
  el.style.background = `url(${rawAvatarData}) center/cover`;
  el.style.transform = `rotate(${avatarRotation}deg)`;
  el.style.transition = 'transform 0.25s ease';
}

$('regAvatarWrap').onclick = () => $('regAvatarInput').click();
$('regAvatarInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => openAvatarPreview(ev.target.result, 'register');
  reader.readAsDataURL(file);
  e.target.value = '';
};

$('editAvatarBtn').onclick = () => $('editAvatarInput').click();
$('editAvatarInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => openAvatarPreview(ev.target.result, 'profile');
  reader.readAsDataURL(file);
  e.target.value = '';
};

$('rotateAvatarBtn').onclick = () => {
  avatarRotation = (avatarRotation + 90) % 360;
  renderAvatarCrop();
};

$('cancelAvatarBtn').onclick = () => {
  $('avatarCropModal').classList.add('hidden');
  rawAvatarData = null; avatarRotation = 0;
};

$('saveAvatarBtn').onclick = async () => {
  if (!rawAvatarData) return;
  const finalData = await applyRotation(rawAvatarData, avatarRotation);

  if (avatarTarget === 'register') {
    const el = $('regAvatarPreview');
    el.style.background = `url(${finalData}) center/cover`;
    el.textContent = '';
    window._regAvatarFinal = finalData;
    $('avatarCropModal').classList.add('hidden');
    rawAvatarData = null; avatarRotation = 0;
    return;
  }

  if (avatarTarget === 'profile') {
    try {
      await api('/api/user/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser.username, avatar: finalData })
      });
      currentUser.avatar = finalData;
      localStorage.setItem('nexus_user', JSON.stringify(currentUser));
      renderAvatar($('myAvatar'), finalData, currentUser.username);
      renderAvatar($('profileAvatar'), finalData, currentUser.username);
      await loadChats();
    } catch (err) { alert(err.message); }
    $('avatarCropModal').classList.add('hidden');
    rawAvatarData = null; avatarRotation = 0;
  }
};

function applyRotation(dataUrl, deg) {
  return new Promise((resolve) => {
    if (deg % 360 === 0) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      const rad = deg * Math.PI / 180;
      const swap = deg % 180 !== 0;
      const w = swap ? img.height : img.width;
      const h = swap ? img.width : img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.src = dataUrl;
  });
}

// ============ REGISTER ============
$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  $('registerError').textContent = '';
  const username = $('regUsername').value.trim().toLowerCase();
  const password = $('regPassword').value;

  if (!/^[a-z0-9]{3,20}$/.test(username)) {
    return $('registerError').textContent = 'Только a-z и 0-9, 3-20 символов';
  }
  if (password.length < 4) return $('registerError').textContent = 'Пароль минимум 4 символа';

  try {
    const data = await api('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, avatar: window._regAvatarFinal || '' })
    });
    pendingTwoFA = { token: data.token, user: data.user };
    show2FA();
  } catch (err) { $('registerError').textContent = err.message; }
};

// ============ LOGIN ============
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  const username = $('loginUsername').value.trim().toLowerCase();
  const password = $('loginPassword').value;

  try {
    const data = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    pendingTwoFA = { token: data.token, user: data.user };
    show2FA();
  } catch (err) { $('loginError').textContent = err.message; }
};

// ============ 2FA ============
function show2FA() {
  $('authScreen').classList.add('hidden');
  $('twoFAScreen').classList.remove('hidden');
  $('twoFACode').value = '';
  $('twoFAError').textContent = '';
  setTimeout(() => $('twoFACode').focus(), 100);
}

$('twoFAForm').onsubmit = async (e) => {
  e.preventDefault();
  $('twoFAError').textContent = '';
  if (!pendingTwoFA) return;
  try {
    const res = await api('/api/verify-2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pendingTwoFA.token, code: $('twoFACode').value.trim() })
    });
    saveSession(pendingTwoFA.token, res.user);
    enterApp();
  } catch (err) { $('twoFAError').textContent = err.message; }
};

// ============ SESSION ============
function saveSession(token, user) {
  currentToken = token; currentUser = user;
  localStorage.setItem('nexus_token', token);
  localStorage.setItem('nexus_user', JSON.stringify(user));
}

function loadSession() {
  const token = localStorage.getItem('nexus_token');
  const user = localStorage.getItem('nexus_user');
  if (token && user) {
    currentToken = token;
    currentUser = JSON.parse(user);
    return true;
  }
  return false;
}

function logout() {
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
  if (ws) try { ws.close(); } catch {}
  location.reload();
}
$('logoutBtn').onclick = logout;

// ============ ENTER APP ============
function enterApp() {
  $('authScreen').classList.add('hidden');
  $('twoFAScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');

  $('myName').textContent = currentUser.username;
  renderAvatar($('myAvatar'), currentUser.avatar, currentUser.username);

  if (currentUser.is_admin) $('adminBtn').style.display = '';

  connectWS();
  loadChats();
}

// ============ WEBSOCKET ============
function connectWS() {
  ws = new WebSocket(`${WS_URL}?token=${currentToken}`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'message') {
      const { chatId, message } = data;
      const chat = chats.find(c => c.id === chatId);
      if (chat) {
        chat.lastMessage = message.text || (message.image ? '📷 Фото' : message.file ? '📎 Файл' : '🎤 Голосовое');
        chat.lastTime = message.time;
        renderChats($('searchInput').value);
      }
      if (currentChatId === chatId) appendMessage(message);
    }
    else if (data.type === 'message_edited') {
      if (currentChatId === data.chatId) {
        const el = document.querySelector(`[data-msg-id="${data.message.id}"]`);
        if (el) updateMessageElement(el, data.message);
      }
    }
    else if (data.type === 'message_deleted') {
      if (currentChatId === data.chatId) {
        const el = document.querySelector(`[data-msg-id="${data.messageId}"]`);
        if (el) el.remove();
      }
    }
    else if (data.type === 'chat_cleared') {
      if (currentChatId === data.chatId) $('messages').innerHTML = '';
      const chat = chats.find(c => c.id === data.chatId);
      if (chat) { chat.lastMessage = ''; chat.lastTime = null; renderChats(); }
    }
    else if (data.type === 'chat_deleted') {
      chats = chats.filter(c => c.id !== data.chatId);
      if (currentChatId === data.chatId) closeChat();
      renderChats();
    }
    else if (data.type === 'chat_blocked') {
      // тебя заблокировали
      const chat = chats.find(c => c.id === data.chatId);
      if (chat) chat.blocked = true;
    }
    else if (data.type === 'account_deleted') {
      showKicked('Аккаунт удалён', 'Администратор удалил ваш аккаунт');
    }
    else if (data.type === 'account_banned') {
      const days = data.days || 0;
      showKicked('Аккаунт забанен', `Вы забанены на ${days} дн. администратором`);
    }
    else if (data.type === 'error') {
      alert(data.message);
    }
  };
  ws.onclose = () => {
    if (currentToken) setTimeout(connectWS, 2000);
  };
}

function showKicked(title, text) {
  $('kickedTitle').textContent = title;
  $('kickedText').textContent = text;
  $('kickedModal').classList.remove('hidden');
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
}

$('kickedBtn').onclick = () => {
  location.href = '/';
};

// ============ CHATS ============
async function loadChats() {
  try {
    chats = await api(`/api/chats?username=${currentUser.username}`);
    renderChats();
  } catch (err) { console.error(err); }
}

function renderChats(filter = '') {
  const list = $('chatList');
  list.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const filtered = chats.filter(c => !f ||
    c.other.display.toLowerCase().includes(f) ||
    c.other.username.toLowerCase().includes(f));

  if (!filtered.length) {
    list.innerHTML = '<p style="padding:20px;text-align:center;color:#94a3b8;font-size:14px;">Нет чатов</p>';
    return;
  }

  filtered.forEach(chat => {
    const div = document.createElement('div');
    div.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    div.innerHTML = `
      <div class="avatar" data-av></div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(chat.other.display)}</div>
        <div class="chat-item-preview">${escapeHtml(chat.lastMessage || 'Нет сообщений')}</div>
      </div>
    `;
    renderAvatar(div.querySelector('[data-av]'), chat.other.avatar, chat.other.username);
    div.onclick = () => openChat(chat);
    list.appendChild(div);
  });
}

async function openChat(chat) {
  currentChatId = chat.id;
  currentChat = chat;
  $('emptyChat').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('chatArea').classList.add('show-mobile');
  $('sidebar').classList.add('hide-mobile');

  renderAvatar($('chatAvatar'), chat.other.avatar, chat.other.username);
  $('chatName').textContent = chat.other.display;
  $('chatStatus').textContent = '@' + chat.other.username;

  // Проверка блокировки
  updateBlockedUI(chat.blocked);

  renderChats($('searchInput').value);

  const messages = await api(`/api/messages/${chat.id}`);
  $('messages').innerHTML = '';
  messages.forEach(m => appendMessage(m, true));
  $('messages').scrollTop = $('messages').scrollHeight;
}

function closeChat() {
  $('chatArea').classList.remove('show-mobile');
  $('sidebar').classList.remove('hide-mobile');
  $('chatView').classList.add('hidden');
  $('emptyChat').classList.remove('hidden');
  currentChatId = null;
  currentChat = null;
}

$('backBtn').onclick = closeChat;

function updateBlockedUI(blocked) {
  if (blocked) {
    $('blockedBanner').classList.remove('hidden');
    $('messageForm').classList.add('hidden');
  } else {
    $('blockedBanner').classList.add('hidden');
    $('messageForm').classList.remove('hidden');
  }
}

// ============ MESSAGES ============
function appendMessage(msg, skipScroll = false) {
  if (document.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  const div = document.createElement('div');
  const isOut = msg.from === currentUser.username;
  div.className = 'message ' + (isOut ? 'out' : 'in');
  div.dataset.msgId = msg.id;
  div.dataset.from = msg.from;
  updateMessageElement(div, msg);
  attachMessageEvents(div, msg);
  $('messages').appendChild(div);
  if (!skipScroll) $('messages').scrollTop = $('messages').scrollHeight;
}

function updateMessageElement(el, msg) {
  let html = '';
  if (msg.replyTo) {
    const authorName = msg.replyTo.from === currentUser.username ? 'Вы' : '@' + msg.replyTo.from;
    html += `<div class="message-reply">
      <div class="message-reply-author">${escapeHtml(authorName)}</div>
      <div>${escapeHtml(msg.replyTo.text || '📎 Вложение')}</div>
    </div>`;
  }
  if (msg.image) html += `<img class="message-image" src="${msg.image}" alt="photo">`;
  if (msg.file) {
    html += `<a class="message-file" href="${msg.file.data}" download="${escapeHtml(msg.file.name)}">
      <div class="message-file-icon">📎</div>
      <div class="message-file-name">${escapeHtml(msg.file.name)}</div>
    </a>`;
  }
  if (msg.voice) {
    const dur = msg.voice.duration || 0;
    html += `<div class="message-voice">
      <button class="voice-play-btn" data-action="play">▶</button>
      <div class="voice-wave">${Array.from({length: 24}).map(() => `<div class="voice-wave-bar" style="height:${20 + Math.random()*80}%"></div>`).join('')}</div>
      <div class="voice-duration">${formatDuration(dur)}</div>
    </div>`;
  }
  if (msg.text) html += `<div>${linkify(msg.text)}</div>`;

  const edited = msg.edited ? '<span class="edited">изменено</span>' : '';
  html += `<span class="message-time">${edited}${formatTime(msg.time)}</span>`;
  el.innerHTML = html;

  const playBtn = el.querySelector('[data-action="play"]');
  if (playBtn) playBtn.onclick = () => toggleVoice(msg, el);
}

function attachMessageEvents(div, msg) {
  const isOut = msg.from === currentUser.username;

  const openMenu = (x, y) => {
    selectedMessage = msg;
    const menu = $('contextMenu');
    // Только для своих показываем edit и delete
    menu.querySelector('[data-action="edit"]').style.display = isOut ? 'block' : 'none';
    menu.querySelector('[data-action="delete"]').style.display = isOut ? 'block' : 'none';
    menu.classList.remove('hidden');
    const mw = 180, mh = 140;
    menu.style.left = Math.min(x, window.innerWidth - mw - 10) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 10) + 'px';
  };

  div.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); });
  let pressTimer = null;
  div.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => {
      const t = e.touches[0];
      openMenu(t.clientX, t.clientY);
    }, 500);
  }, { passive: true });
  div.addEventListener('touchend', () => clearTimeout(pressTimer));
  div.addEventListener('touchmove', () => clearTimeout(pressTimer));
}

// ============ SEND ============
$('messageForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !currentChatId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: 'message', chatId: currentChatId, text };
  if (replyingTo) payload.replyTo = replyingTo;
  ws.send(JSON.stringify(payload));
  input.value = '';
  clearReply();
};

// ============ REPLY ============
function setReply(msg) {
  replyingTo = {
    id: msg.id, from: msg.from,
    text: msg.text || (msg.image ? '📷 Фото' : msg.file ? '📎 Файл' : '🎤 Голосовое')
  };
  $('replyTitle').textContent = 'Ответ: ' + (msg.from === currentUser.username ? 'Вы' : '@' + msg.from);
  $('replyText').textContent = replyingTo.text;
  $('replyPreview').classList.remove('hidden');
  $('messageInput').focus();
}

function clearReply() {
  replyingTo = null;
  $('replyPreview').classList.add('hidden');
}
$('replyClose').onclick = clearReply;

// ============ CONTEXT MENU (message) ============
document.querySelectorAll('#contextMenu button').forEach(btn => {
  btn.onclick = () => {
    const action = btn.dataset.action;
    const msg = selectedMessage;
    $('contextMenu').classList.add('hidden');
    if (!msg) return;
    if (action === 'reply') setReply(msg);
    else if (action === 'edit') {
      editingMsgId = msg.id;
      $('editText').value = msg.text || '';
      $('editModal').classList.remove('hidden');
      setTimeout(() => $('editText').focus(), 100);
    }
    else if (action === 'delete') {
      if (confirm('Удалить сообщение?')) {
        ws.send(JSON.stringify({ type: 'delete', chatId: currentChatId, messageId: msg.id }));
      }
    }
  };
});

$('saveEdit').onclick = () => {
  const text = $('editText').value.trim();
  if (!text || !editingMsgId) return;
  ws.send(JSON.stringify({ type: 'edit', chatId: currentChatId, messageId: editingMsgId, text }));
  $('editModal').classList.add('hidden');
  editingMsgId = null;
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('#contextMenu')) $('contextMenu').classList.add('hidden');
  if (!e.target.closest('#chatMenu') && !e.target.closest('#chatDotsBtn')) $('chatMenu').classList.add('hidden');
  if (!e.target.closest('#adminContextMenu')) $('adminContextMenu').classList.add('hidden');
});

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.onclick = () => {
    const id = btn.dataset.close;
    $(id).classList.add('hidden');
    if (id === 'voiceModal') cancelRecording();
    if (id === 'photoModal') pendingPhoto = null;
    if (id === 'avatarCropModal') { rawAvatarData = null; avatarRotation = 0; }
  };
});

// ============ CHAT DOTS MENU ============
$('chatDotsBtn').onclick = (e) => {
  e.stopPropagation();
  if (!currentChat) return;
  const menu = $('chatMenu');
  const blockBtn = menu.querySelector('[data-action="block"]');
  const rect = e.currentTarget.getBoundingClientRect();
  // Если уже заблокирован — покажем разблокировать
  if (currentChat.blocked) {
    blockBtn.textContent = '✅ Разблокировать';
  } else {
    blockBtn.textContent = '🚫 Заблокировать';
  }
  menu.classList.remove('hidden');
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.min(rect.right - 180, window.innerWidth - 190) + 'px';
};

document.querySelectorAll('#chatMenu button').forEach(btn => {
  btn.onclick = async () => {
    const action = btn.dataset.action;
    $('chatMenu').classList.add('hidden');
    if (!currentChat) return;

    if (action === 'clear') {
      if (!confirm('Очистить всю историю чата?')) return;
      await api(`/api/chats/${currentChat.id}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser.username })
      });
      $('messages').innerHTML = '';
    }
    else if (action === 'block') {
      if (currentChat.blocked) {
        await api(`/api/chats/${currentChat.id}/unblock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser.username })
        });
        currentChat.blocked = false;
        updateBlockedUI(false);
      } else {
        await api(`/api/chats/${currentChat.id}/block`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser.username })
        });
        currentChat.blocked = true;
        updateBlockedUI(true);
      }
    }
    else if (action === 'delete-chat') {
      if (!confirm('Удалить чат со всей историей?')) return;
      await api(`/api/chats/${currentChat.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser.username })
      });
      chats = chats.filter(c => c.id !== currentChat.id);
      closeChat();
      renderChats();
    }
  };
});

$('unblockBtn').onclick = async () => {
  if (!currentChat) return;
  await api(`/api/chats/${currentChat.id}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser.username })
  });
  currentChat.blocked = false;
  updateBlockedUI(false);
};

// ============ SEARCH ============
let searchDebounce = null;
$('searchInput').oninput = (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchDebounce);
  if (!q) { $('searchResults').classList.add('hidden'); renderChats(''); return; }
  renderChats(q);
  searchDebounce = setTimeout(() => searchUsers(q), 300);
};

async function searchUsers(q) {
  const results = $('searchResults');
  try {
    const users = await api(`/api/search?q=${encodeURIComponent(q)}&me=${currentUser.username}`);
    if (!users.length) { results.classList.add('hidden'); return; }
    results.innerHTML = '';
    users.forEach(u => {
      const div = document.createElement('div');
      div.className = 'search-user';
      div.innerHTML = `
        <div class="avatar" style="width:36px;height:36px;font-size:14px"></div>
        <div style="flex:1">
          <div class="search-user-name">${escapeHtml(u.display)}</div>
          <div class="search-user-username">@${escapeHtml(u.username)}</div>
        </div>
      `;
      renderAvatar(div.querySelector('.avatar'), u.avatar, u.username);
      div.onclick = () => {
        $('searchResults').classList.add('hidden');
        $('searchInput').value = '';
        createChatWith(u.username);
      };
      results.appendChild(div);
    });
    results.classList.remove('hidden');
  } catch {}
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) $('searchResults').classList.add('hidden');
});

// ============ NEW CHAT ============
$('newChatBtn').onclick = () => {
  $('newChatModal').classList.remove('hidden');
  $('newChatUsername').value = '';
  $('newChatError').textContent = '';
  setTimeout(() => $('newChatUsername').focus(), 100);
};

$('createChat').onclick = () => {
  const u = $('newChatUsername').value.trim().toLowerCase().replace('@', '');
  if (!u) return $('newChatError').textContent = 'Введите username';
  createChatWith(u);
};

async function createChatWith(username) {
  try {
    const data = await api('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: currentUser.username, to: username })
    });
    $('newChatModal').classList.add('hidden');
    await loadChats();
    const chat = chats.find(c => c.id === data.id);
    if (chat) openChat(chat);
  } catch (err) { $('newChatError').textContent = err.message; }
}

// ============ MY PROFILE ============
$('myProfileBtn').onclick = () => {
  renderAvatar($('profileAvatar'), currentUser.avatar, currentUser.username);
  $('profileUsername').textContent = '@' + currentUser.username;
  $('myProfileModal').classList.remove('hidden');
};

// ============ USER PROFILE ============
$('chatHeaderClick').onclick = () => {
  if (!currentChat) return;
  const u = currentChat.other;
  renderAvatar($('uProfileAvatar'), u.avatar, u.username);
  $('uProfileUsername').textContent = '@' + u.username;
  $('userProfileModal').classList.remove('hidden');
};

$('copyUsernameBtn').onclick = async () => {
  const username = currentChat.other.username;
  try {
    await navigator.clipboard.writeText('@' + username);
    const btn = $('copyUsernameBtn');
    btn.classList.add('copied'); btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋'; }, 1500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = '@' + username;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
};

// ============ ATTACHMENTS ============
$('attachBtn').onclick = () => $('attachmentPanel').classList.toggle('hidden');
$('attachPhotoBtn').onclick = () => { $('attachmentPanel').classList.add('hidden'); $('hiddenPhotoInput').click(); };
$('attachFileBtn').onclick = () => { $('attachmentPanel').classList.add('hidden'); $('hiddenFileInput').click(); };

$('hiddenPhotoInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingPhoto = ev.target.result;
    $('photoPreview').src = pendingPhoto;
    $('photoModal').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};

$('sendPhotoBtn').onclick = () => {
  if (!pendingPhoto || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', chatId: currentChatId, image: pendingPhoto, replyTo: replyingTo }));
  $('photoModal').classList.add('hidden');
  pendingPhoto = null;
  clearReply();
};

$('hiddenFileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Файл больше 5MB'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    ws.send(JSON.stringify({
      type: 'message', chatId: currentChatId,
      file: { name: file.name, data: ev.target.result, size: file.size },
      replyTo: replyingTo
    }));
    clearReply();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};

// ============ VOICE ============
$('recordBtn').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const duration = (Date.now() - recordingStartTime) / 1000;
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ws && ws.readyState === WebSocket.OPEN && currentChatId) {
          ws.send(JSON.stringify({
            type: 'message', chatId: currentChatId,
            voice: { data: ev.target.result, duration }, replyTo: replyingTo
          }));
          clearReply();
        }
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    recordingStartTime = Date.now();
    $('voiceModal').classList.remove('hidden');
    $('voiceTimer').textContent = '00:00';
    recordingTimer = setInterval(() => {
      const sec = (Date.now() - recordingStartTime) / 1000;
      $('voiceTimer').textContent = formatDuration(sec);
      if (sec > 120) stopRecording();
    }, 200);
  } catch (err) { alert('Не удалось получить микрофон: ' + err.message); }
};

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  $('voiceModal').classList.add('hidden');
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  audioChunks = [];
}

$('stopRecordBtn').onclick = stopRecording;

function toggleVoice(msg, el) {
  const btn = el.querySelector('.voice-play-btn');
  const waveBars = el.querySelectorAll('.voice-wave-bar');
  if (currentPlayingId === msg.id && !voicePlayer.paused) {
    voicePlayer.pause(); btn.textContent = '▶'; return;
  }
  if (currentPlayingId !== msg.id) {
    voicePlayer.pause();
    voicePlayer = new Audio(msg.voice.data);
    currentPlayingId = msg.id;
    waveBars.forEach(b => b.classList.remove('played'));
    voicePlayer.ontimeupdate = () => {
      const progress = voicePlayer.currentTime / (voicePlayer.duration || 1);
      waveBars.forEach((b, i) => b.classList.toggle('played', i / waveBars.length <= progress));
    };
    voicePlayer.onended = () => {
      btn.textContent = '▶';
      waveBars.forEach(b => b.classList.remove('played'));
      currentPlayingId = null;
    };
  }
  voicePlayer.play();
  btn.textContent = '❚❚';
}

// ============ ADMIN ============
$('adminBtn').onclick = async () => {
  try {
    const users = await api(`/api/admin/users?admin=${currentUser.username}`);
    const list = $('adminList');
    list.innerHTML = '';
    if (!users.length) {
      list.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px;font-size:13px;">Нет пользователей</p>';
    }
    users.forEach(u => {
      const div = document.createElement('div');
      div.className = 'admin-user';
      const banned = u.banned_until && u.banned_until > Date.now() / 1000;
      const badge = banned
        ? '<span class="admin-user-badge banned">забанен</span>'
        : (u.online ? '<span class="admin-user-badge">online</span>' : '<span class="admin-user-badge offline">offline</span>');
      div.innerHTML = `
        <div class="avatar" data-av style="width:38px;height:38px;font-size:14px"></div>
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(u.display)}</div>
          <div class="admin-user-username">@${escapeHtml(u.username)}</div>
        </div>
        ${badge}
      `;
      renderAvatar(div.querySelector('[data-av]'), u.avatar, u.username);

      const openMenu = (x, y) => {
        selectedAdminUser = u;
        const menu = $('adminContextMenu');
        menu.classList.remove('hidden');
        menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
      };
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); });
      let pressTimer = null;
      div.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
          const t = e.touches[0];
          openMenu(t.clientX, t.clientY);
        }, 500);
      }, { passive: true });
      div.addEventListener('touchend', () => clearTimeout(pressTimer));
      div.addEventListener('touchmove', () => clearTimeout(pressTimer));

      list.appendChild(div);
    });
    $('adminModal').classList.remove('hidden');
  } catch (err) { alert(err.message); }
};

document.querySelectorAll('#adminContextMenu button').forEach(btn => {
  btn.onclick = () => {
    const action = btn.dataset.action;
    $('adminContextMenu').classList.add('hidden');
    if (!selectedAdminUser) return;

    if (action === 'admin-delete') {
      if (!confirm(`Удалить аккаунт @${selectedAdminUser.username}?`)) return;
      api('/api/admin/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin: currentUser.username, target: selectedAdminUser.username })
      }).then(() => {
        const el = [...document.querySelectorAll('.admin-user')]
          .find(d => d.querySelector('.admin-user-username').textContent === '@' + selectedAdminUser.username);
        if (el) el.remove();
      }).catch(err => alert(err.message));
    }
    else if (action === 'admin-ban') {
      $('banTarget').textContent = '@' + selectedAdminUser.username;
      $('banModal').classList.remove('hidden');
    }
  };
});

document.querySelectorAll('.ban-option').forEach(btn => {
  btn.onclick = async () => {
    const days = parseInt(btn.dataset.days);
    $('banModal').classList.add('hidden');
    if (!selectedAdminUser) return;
    try {
      await api('/api/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin: currentUser.username,
          target: selectedAdminUser.username,
          days
        })
      });
      alert(`@${selectedAdminUser.username} забанен на ${days} дн.`);
    } catch (err) { alert(err.message); }
  };
});

// ============ ESC ============
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => {
      if (m.id === 'voiceModal') cancelRecording();
      if (m.id === 'avatarCropModal') { rawAvatarData = null; avatarRotation = 0; }
      if (m.id !== 'kickedModal') m.classList.add('hidden');
    });
    $('contextMenu').classList.add('hidden');
    $('chatMenu').classList.add('hidden');
    $('adminContextMenu').classList.add('hidden');
    $('attachmentPanel').classList.add('hidden');
    clearReply();
  }
});

// ============ START ============
if (loadSession()) enterApp();