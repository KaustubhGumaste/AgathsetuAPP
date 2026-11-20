"""Signup email verification: 6-digit codes sent through Gmail (or any SMTP server).

Configure in backend/.env:
    SMTP_USERNAME=youraccount@gmail.com
    SMTP_PASSWORD=<16-character Google app password>   # not the normal Gmail password
    SMTP_FROM=AGHAT SETHU <youraccount@gmail.com>       # optional
    SMTP_HOST=smtp.gmail.com  SMTP_PORT=587             # defaults
Verification is required for signup only when SMTP_USERNAME and SMTP_PASSWORD are set
(or EMAIL_OTP_REQUIRED=true, which refuses signups until mail is configured).
"""

import hashlib
import hmac
import os
import secrets
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import jwt

from .security import JWT_ALGORITHM, JWT_SECRET

OTP_TTL = timedelta(minutes=10)
OTP_RESEND_AFTER = timedelta(seconds=60)
OTP_MAX_PER_HOUR = 5
OTP_MAX_ATTEMPTS = 5
VERIFICATION_TTL = timedelta(minutes=30)
VERIFICATION_PURPOSE = "email_verified"


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_USERNAME", "").strip() and os.getenv("SMTP_PASSWORD", "").strip())


def otp_required() -> bool:
    return smtp_configured() or os.getenv("EMAIL_OTP_REQUIRED", "").strip().lower() in {"1", "true", "yes"}


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_code(email: str, code: str) -> str:
    return hmac.new(JWT_SECRET.encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def code_matches(email: str, code: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_code(email, code), expected_hash)


def verification_token(email: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"purpose": VERIFICATION_PURPOSE, "email": email, "iat": now, "exp": now + VERIFICATION_TTL},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def verified_email(token: str | None) -> str | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("purpose") != VERIFICATION_PURPOSE or not isinstance(payload.get("email"), str):
        return None
    return payload["email"]


def send_code(email: str, code: str) -> None:
    """Sends the code; raises on any SMTP failure. Blocking: call it in a worker thread."""
    username = os.getenv("SMTP_USERNAME", "").strip()
    message = EmailMessage()
    message["Subject"] = f"{code} is your AGHAT SETHU verification code"
    message["From"] = os.getenv("SMTP_FROM", "").strip() or f"AGHAT SETHU <{username}>"
    message["To"] = email
    message.set_content(
        f"Your AGHAT SETHU verification code is {code}.\n\n"
        f"It expires in {int(OTP_TTL.total_seconds() // 60)} minutes. "
        "If you did not try to create an account, ignore this email.\n"
    )
    host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20) as server:
            server.login(username, os.getenv("SMTP_PASSWORD", "").strip())
            server.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.starttls(context=context)
            server.login(username, os.getenv("SMTP_PASSWORD", "").strip())
            server.send_message(message)
