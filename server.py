from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Dict, List, Optional
import bcrypt
import uuid
import time
import json
import random
import re
import os

app = FastAPI(title="Nexus Messenger")

# ============ STORAGE ============
users: Dict[str, dict] = {}
chats: Dict[str, dict] = {}
sessions: Dict[str, str] = {}
pending_sessions: Dict[str, dict] = {}
sockets: Dict[str, WebSocket] = {}

ADMIN_USERNAME = "andrey"  # первый пользователь автоматически становится админом
USERNAME_RE = re.compile(r"^[a-z0-9]{3,20}$")


# ============ MODELS ============
class RegisterData(BaseModel):
    username: str
    password: str
    avatar: Optional[str] = ""


class LoginData(BaseModel):
    username: str
    password: str


class TwoFAData(BaseModel):
    token: str
    code: str


class AvatarData(BaseModel):
    username: str
    avatar: str


class AdminAction(BaseModel):
    admin: str
    target: str
    days: Optional[int] = 0  # для бана


# ============ HELPERS ============
def safe_user(u: dict) -> dict:
    return {
        "username": u["username"],
        "display": u["display"],
        "avatar": u.get("avatar", ""),
        "is_admin": u["username"] == ADMIN_USERNAME,
        "banned_until": u.get("banned_until", 0)
    }


def is_banned(u: dict) -> bool:
    bu = u.get("banned_until", 0)
    if bu and bu > time.time():
        return True
    if bu and bu <= time.time():
        u["banned_until"] = 0
    return False


def print_code(code: str, username: str):
    print()
    print("╔══════════════════════════════════════╗")
    print("║      🔐  ДВУХЭТАПНАЯ АУТЕНТИФИКАЦИЯ  ║")
    print("╠══════════════════════════════════════╣")
    print(f"║  Пользователь: @{username:<20} ║")
    print(f"║  Код:  {code:<30} ║")
    print("╚══════════════════════════════════════╝")
    print()


def find_chat_between(a: str, b: str):
    for chat in chats.values():
        if len(chat["members"]) == 2 and a in chat["members"] and b in chat["members"]:
            return chat
    return None


async def broadcast(chat: dict, payload: dict):
    data = json.dumps(payload)
    for member in chat["members"]:
        sock = sockets.get(member)
        if sock:
            try:
                await sock.send_text(data)
            except Exception:
                pass


# ============ REGISTER ============
@app.post("/api/register")
async def register(data: RegisterData):
    username = data.username.strip().lower()
    password = data.password

    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Username: только a-z и 0-9, 3-20 символов")
    if len(password) < 4:
        raise HTTPException(400, "Пароль минимум 4 символа")
    if username in users:
        raise HTTPException(400, "Пользователь уже существует")

    # Первый зарегистрированный = админ
    global ADMIN_USERNAME
    if not users:
        ADMIN_USERNAME = username

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user = {
        "id": str(uuid.uuid4()),
        "username": username,
        "display": username,
        "password": hashed,
        "avatar": data.avatar or "",
        "banned_until": 0
    }
    users[username] = user

    code = f"{random.randint(0, 999999):06d}"
    token = str(uuid.uuid4())
    pending_sessions[token] = {"username": username, "code": code}
    print_code(code, username)

    return {"token": token, "user": safe_user(user), "need2fa": True}


# ============ LOGIN ============
@app.post("/api/login")
async def login(data: LoginData):
    username = data.username.strip().lower()
    user = users.get(username)
    if not user:
        raise HTTPException(400, "Неверный логин или пароль")

    if is_banned(user):
        remain = int((user["banned_until"] - time.time()) / 86400) + 1
        raise HTTPException(403, f"Аккаунт забанен на {remain} дн.")

    ok = bcrypt.checkpw(data.password.encode(), user["password"].encode())
    if not ok:
        raise HTTPException(400, "Неверный логин или пароль")

    code = f"{random.randint(0, 999999):06d}"
    token = str(uuid.uuid4())
    pending_sessions[token] = {"username": username, "code": code}
    print_code(code, username)

    return {"token": token, "user": safe_user(user), "need2fa": True}


# ============ VERIFY 2FA ============
@app.post("/api/verify-2fa")
async def verify_2fa(data: TwoFAData):
    pending = pending_sessions.get(data.token)
    if not pending:
        raise HTTPException(400, "Сессия истекла")
    if pending["code"] != data.code.strip():
        raise HTTPException(400, "Неверный код")

    username = pending["username"]
    user = users.get(username)
    if is_banned(user):
        remain = int((user["banned_until"] - time.time()) / 86400) + 1
        raise HTTPException(403, f"Аккаунт забанен на {remain} дн.")

    sessions[data.token] = username
    del pending_sessions[data.token]
    return {"ok": True, "user": safe_user(user)}


# ============ SEARCH ============
@app.get("/api/search")
async def search_users(q: str = Query(""), me: str = Query("")):
    q = q.strip().lower().lstrip("@")
    me = me.lower()
    if not q:
        return []
    results = []
    for u in users.values():
        if u["username"] == me or is_banned(u):
            continue
        if q in u["username"] or q in u["display"].lower():
            results.append(safe_user(u))
        if len(results) >= 10:
            break
    return results


# ============ GET USER ============
@app.get("/api/user/{username}")
async def get_user(username: str):
    u = users.get(username.lower())
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    return safe_user(u)


# ============ UPDATE AVATAR ============
@app.post("/api/user/avatar")
async def update_avatar(data: AvatarData):
    u = users.get(data.username.lower())
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    u["avatar"] = data.avatar
    return {"ok": True}


# ============ ADMIN ============
@app.get("/api/admin/users")
async def admin_users(admin: str = Query(...)):
    if admin.lower() != ADMIN_USERNAME:
        raise HTTPException(403, "Нет прав")
    # Все пользователи, кроме самого админа
    result = []
    for u in users.values():
        if u["username"] == ADMIN_USERNAME:
            continue
        result.append({
            "username": u["username"],
            "display": u["display"],
            "avatar": u.get("avatar", ""),
            "banned_until": u.get("banned_until", 0),
            "online": u["username"] in sockets
        })
    return result


@app.post("/api/admin/delete")
async def admin_delete(data: AdminAction):
    if data.admin.lower() != ADMIN_USERNAME:
        raise HTTPException(403, "Нет прав")
    target = data.target.lower()
    if target == ADMIN_USERNAME:
        raise HTTPException(400, "Нельзя удалить админа")
    if target not in users:
        raise HTTPException(404, "Пользователь не найден")

    # Уведомить, если онлайн
    sock = sockets.get(target)
    if sock:
        try:
            await sock.send_text(json.dumps({
                "type": "account_deleted",
                "message": "Аккаунт удалён администратором"
            }))
        except Exception:
            pass

    # Удалить
    del users[target]
    # Удалить все его чаты и из чужих чатов
    to_delete = []
    for cid, chat in chats.items():
        if target in chat["members"]:
            to_delete.append(cid)
    for cid in to_delete:
        del chats[cid]

    return {"ok": True}


@app.post("/api/admin/ban")
async def admin_ban(data: AdminAction):
    if data.admin.lower() != ADMIN_USERNAME:
        raise HTTPException(403, "Нет прав")
    target = data.target.lower()
    if target == ADMIN_USERNAME:
        raise HTTPException(400, "Нельзя забанить админа")
    if target not in users:
        raise HTTPException(404, "Пользователь не найден")

    days = max(0, data.days or 0)
    users[target]["banned_until"] = time.time() + days * 86400

    # Уведомить, если онлайн
    sock = sockets.get(target)
    if sock:
        try:
            await sock.send_text(json.dumps({
                "type": "account_banned",
                "days": days,
                "message": f"Аккаунт забанен на {days} дн. администратором"
            }))
        except Exception:
            pass
        try:
            await sock.close()
        except Exception:
            pass
        sockets.pop(target, None)

    return {"ok": True}


# ============ CHATS ============
@app.get("/api/chats")
async def get_chats(username: str = Query(...)):
    username = username.lower()
    my_chats = []
    for chat in chats.values():
        if username in chat["members"]:
            other_name = next((m for m in chat["members"] if m != username), None)
            other_user = users.get(other_name) if other_name else None
            last_msg = chat["messages"][-1] if chat["messages"] else None
            preview = ""
            if last_msg:
                preview = (last_msg.get("text")
                           or ("📷 Фото" if last_msg.get("image")
                               else ("📎 " + last_msg["file"]["name"] if last_msg.get("file")
                                     else "🎤 Голосовое")))
            my_chats.append({
                "id": chat["id"],
                "other": safe_user(other_user) if other_user else {
                    "username": other_name or "?", "display": other_name or "?", "avatar": ""
                },
                "lastMessage": preview,
                "lastTime": last_msg["time"] if last_msg else None,
                "blocked": username in chat.get("blocked_by", [])
            })
    my_chats.sort(key=lambda c: c["lastTime"] or 0, reverse=True)
    return my_chats


@app.post("/api/chats")
async def create_chat(data: dict):
    from_u = data.get("from", "").lower()
    to_u = data.get("to", "").lower()

    if to_u not in users:
        raise HTTPException(404, "Пользователь не найден")
    if from_u == to_u:
        raise HTTPException(400, "Нельзя создать чат с собой")
    if is_banned(users.get(from_u)):
        raise HTTPException(403, "Вы забанены")

    existing = find_chat_between(from_u, to_u)
    if existing:
        return {"id": existing["id"]}

    chat = {
        "id": str(uuid.uuid4()),
        "members": [from_u, to_u],
        "messages": [],
        "blocked_by": []  # кто кого заблокировал
    }
    chats[chat["id"]] = chat
    return {"id": chat["id"]}


@app.get("/api/messages/{chat_id}")
async def get_messages(chat_id: str):
    chat = chats.get(chat_id)
    if not chat:
        raise HTTPException(404, "Чат не найден")
    return chat["messages"]


@app.post("/api/chats/{chat_id}/delete")
async def delete_chat(chat_id: str, data: dict):
    username = data.get("username", "").lower()
    chat = chats.get(chat_id)
    if not chat or username not in chat["members"]:
        raise HTTPException(404, "Чат не найден")
    # Уведомить собеседника
    other = next((m for m in chat["members"] if m != username), None)
    if other:
        sock = sockets.get(other)
        if sock:
            try:
                await sock.send_text(json.dumps({
                    "type": "chat_deleted",
                    "chatId": chat_id,
                    "by": username
                }))
            except Exception:
                pass
    del chats[chat_id]
    return {"ok": True}


@app.post("/api/chats/{chat_id}/clear")
async def clear_chat(chat_id: str, data: dict):
    username = data.get("username", "").lower()
    chat = chats.get(chat_id)
    if not chat or username not in chat["members"]:
        raise HTTPException(404, "Чат не найден")
    chat["messages"] = []
    # Уведомить обоих
    await broadcast(chat, {"type": "chat_cleared", "chatId": chat_id})
    return {"ok": True}


@app.post("/api/chats/{chat_id}/block")
async def block_chat(chat_id: str, data: dict):
    username = data.get("username", "").lower()
    chat = chats.get(chat_id)
    if not chat or username not in chat["members"]:
        raise HTTPException(404, "Чат не найден")
    blocked = chat.setdefault("blocked_by", [])
    if username not in blocked:
        blocked.append(username)
    other = next((m for m in chat["members"] if m != username), None)
    if other:
        sock = sockets.get(other)
        if sock:
            try:
                await sock.send_text(json.dumps({
                    "type": "chat_blocked",
                    "chatId": chat_id,
                    "by": username
                }))
            except Exception:
                pass
    return {"ok": True}


@app.post("/api/chats/{chat_id}/unblock")
async def unblock_chat(chat_id: str, data: dict):
    username = data.get("username", "").lower()
    chat = chats.get(chat_id)
    if not chat or username not in chat["members"]:
        raise HTTPException(404, "Чат не найден")
    blocked = chat.setdefault("blocked_by", [])
    if username in blocked:
        blocked.remove(username)
    return {"ok": True}


# ============ WEBSOCKET ============
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    username = sessions.get(token)
    if not username:
        await websocket.close(code=1008)
        return

    user = users.get(username)
    if not user or is_banned(user):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    sockets[username] = websocket

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            chat_id = msg.get("chatId")

            if mtype == "message":
                chat = chats.get(chat_id)
                if not chat or username not in chat["members"]:
                    continue
                # Проверка блокировки
                blocked = chat.get("blocked_by", [])
                other = next((m for m in chat["members"] if m != username), None)
                if other in blocked:
                    # ты заблокирован собеседником
                    try:
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "Собеседник вас заблокировал"
                        }))
                    except Exception:
                        pass
                    continue

                text = (msg.get("text") or "").strip()
                image = msg.get("image")
                file_ = msg.get("file")
                voice = msg.get("voice")
                reply_to = msg.get("replyTo")

                if not (text or image or file_ or voice):
                    continue

                message = {
                    "id": str(uuid.uuid4()),
                    "from": username,
                    "time": int(time.time() * 1000),
                }
                if text: message["text"] = text
                if image: message["image"] = image
                if file_: message["file"] = file_
                if voice: message["voice"] = voice
                if reply_to:
                    original = next((m for m in chat["messages"] if m["id"] == reply_to.get("id")), None)
                    if original:
                        orig_text = (original.get("text")
                                     or ("📷 Фото" if original.get("image")
                                         else ("📎 " + original["file"]["name"] if original.get("file")
                                               else "🎤 Голосовое")))
                        message["replyTo"] = {
                            "id": original["id"],
                            "from": original["from"],
                            "text": orig_text
                        }
                chat["messages"].append(message)
                await broadcast(chat, {"type": "message", "chatId": chat_id, "message": message})

            elif mtype == "edit":
                chat = chats.get(chat_id)
                if not chat or username not in chat["members"]:
                    continue
                msg_id = msg.get("messageId")
                new_text = (msg.get("text") or "").strip()
                for m in chat["messages"]:
                    if m["id"] == msg_id and m["from"] == username:
                        m["text"] = new_text
                        m["edited"] = True
                        await broadcast(chat, {
                            "type": "message_edited",
                            "chatId": chat_id,
                            "message": m
                        })
                        break

            elif mtype == "delete":
                chat = chats.get(chat_id)
                if not chat or username not in chat["members"]:
                    continue
                msg_id = msg.get("messageId")
                new_msgs = [m for m in chat["messages"]
                            if not (m["id"] == msg_id and m["from"] == username)]
                if len(new_msgs) != len(chat["messages"]):
                    chat["messages"] = new_msgs
                    await broadcast(chat, {
                        "type": "message_deleted",
                        "chatId": chat_id,
                        "messageId": msg_id
                    })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print("WS error:", e)
    finally:
        if sockets.get(username) is websocket:
            del sockets[username]


# ============ STATIC / PAGES ============
@app.get("/")
async def index():
    return FileResponse("index.html")


@app.get("/mobile")
async def mobile():
    return FileResponse("mobile.html")


# Монтируем статику, но НЕ перехватываем /api и /ws
app.mount("/", StaticFiles(directory=".", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    print("✅ Сервер запущен: http://localhost:3000")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3000)))