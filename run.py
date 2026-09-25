"""Start the reader study server:  python run.py"""
import uvicorn

from app.config import CONFIG

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=CONFIG["server"]["host"], port=int(CONFIG["server"]["port"]),
                workers=1, log_level="info")
