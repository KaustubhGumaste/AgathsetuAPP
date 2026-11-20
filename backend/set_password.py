"""Set a new password for an existing AGHAT SETHU account (run on the server machine).

    backend\\.venv\\Scripts\\python.exe -m backend.set_password someone@example.com

The password is typed at a hidden prompt, so it never appears on screen or in shell history.
"""
import getpass
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import engine
from .models import User
from .security import hash_password


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python -m backend.set_password <email>")
        return 2
    email = sys.argv[1].strip().lower()
    with Session(engine) as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            print(f"No account with email {email}.")
            return 1
        password = getpass.getpass(f"New password for {email} ({user.role}): ")
        if len(password) < 8:
            print("Password must be at least 8 characters. Nothing changed.")
            return 1
        if getpass.getpass("Type it again: ") != password:
            print("The two passwords differ. Nothing changed.")
            return 1
        user.password_hash = hash_password(password)
        db.commit()
    print(f"Password updated for {email}. Sign in with it in the app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
