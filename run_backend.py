"""Start GoalPulse using the Python/FastAPI backend."""
import os
import uvicorn

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "4173")), reload=False)
