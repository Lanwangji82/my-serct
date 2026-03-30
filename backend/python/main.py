from __future__ import annotations

import uvicorn

try:
    from .app.bootstrap.platform_app import create_platform_app_bundle
except ImportError:
    from app.bootstrap.platform_app import create_platform_app_bundle


bundle = create_platform_app_bundle()
app = bundle.app
APP_PORT = bundle.app_port


def run() -> None:
    uvicorn.run(
        "backend.python.main:app",
        host="127.0.0.1",
        port=APP_PORT,
        reload=False,
        timeout_graceful_shutdown=2,
    )


if __name__ == "__main__":
    run()
