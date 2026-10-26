FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY dist ./dist
COPY run_backend.py ./
RUN useradd --create-home --uid 10001 goalpulse && mkdir /data && chown goalpulse:goalpulse /data
USER goalpulse
ENV HOST=0.0.0.0 PORT=8080 GOALPULSE_DATA_DIR=/data
EXPOSE 8080
CMD ["python", "run_backend.py"]
