import os
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt
from pwdlib import PasswordHash

from .models import User

password_hash = PasswordHash.recommended()


def jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET_KEY")
    if secret:
        return secret
    if os.getenv("APP_ENV", "development").lower() == "production":
        raise RuntimeError("JWT_SECRET_KEY must be set in production.")
    generated = secrets.token_urlsafe(48)
    print("WARNING: using a temporary development JWT secret; sessions expire after restart.")
    return generated


JWT_SECRET = jwt_secret()
JWT_ALGORITHM = "HS256"
JWT_TTL_MINUTES = int(os.getenv("JWT_TTL_MINUTES", "60"))


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, encoded: str) -> bool:
    try:
        return password_hash.verify(password, encoded)
    except (ValueError, TypeError):
        return False


def create_access_token(user: User) -> tuple[str, str, datetime]:
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=JWT_TTL_MINUTES)
    token_id = str(uuid4())
    token = jwt.encode(
        {
            "sub": user.id,
            "role": user.role,
            "iat": now,
            "exp": expires_at,
            "jti": token_id,
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return token, token_id, expires_at


def decode_access_token(token: str) -> dict[str, object] | None:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if not isinstance(payload.get("sub"), str) or not isinstance(payload.get("jti"), str):
        return None
    return payload
