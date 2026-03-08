"""PostGIS Studio CLI.

Usage:
    uv run python main.py serve           # start web server on http://127.0.0.1:8001
    uv run python main.py serve --reload  # dev hot-reload
"""

import argparse


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn
    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="postgisstudio",
        description="PostGIS Studio — SQL explorer for PostGIS",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── serve ──────────────────────────────────────────────────────────────────
    serve_p = sub.add_parser("serve", help="Start the FastAPI web server")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=8001)
    serve_p.add_argument("--reload", action="store_true",
                         help="Enable hot-reload (development mode)")
    serve_p.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
