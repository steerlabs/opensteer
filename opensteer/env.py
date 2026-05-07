"""Environment loading helpers."""

import os
from pathlib import Path


def load_env():
    """Load simple KEY=VALUE pairs from local Opensteer .env files."""
    for path in (Path.cwd() / ".env", Path(__file__).parent / ".env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
