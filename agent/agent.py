#!/usr/bin/env python3
"""Lightweight Probe Agent for Linux hosts."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import random
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass

import psutil
import websockets


MIB = 1024 * 1024

# Loopback, container, bridge and tunnel interfaces either never leave the
# host or repeat traffic already counted on the physical NIC.
VIRTUAL_INTERFACE_PREFIXES = (
    "lo",
    "docker",
    "veth",
    "br-",
    "virbr",
    "vnet",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "cni",
    "flannel",
    "cali",
    "kube",
    "vxlan",
    "ifb",
)


def net_counters() -> tuple[int, int]:
    rx = tx = 0
    for name, counters in psutil.net_io_counters(pernic=True).items():
        if name.lower().startswith(VIRTUAL_INTERFACE_PREFIXES):
            continue
        rx += counters.bytes_recv
        tx += counters.bytes_sent
    return rx, tx


@dataclass
class AgentConfig:
    server_url: str
    server_id: str
    token: str
    display_name: str
    region: str
    provider: str
    interval_seconds: float = 2.0

    @classmethod
    def from_environment(cls) -> "AgentConfig":
        server_url = os.environ.get(
            "PROBE_SERVER_URL", "ws://127.0.0.1:8080/ws/agent"
        )
        server_id = os.environ.get("PROBE_SERVER_ID", "").strip()
        token = os.environ.get("PROBE_AGENT_TOKEN", "").strip()
        if not server_id or not token:
            raise RuntimeError(
                "PROBE_SERVER_ID and PROBE_AGENT_TOKEN are required"
            )
        return cls(
            server_url=server_url,
            server_id=server_id,
            token=token,
            display_name=os.environ.get("PROBE_DISPLAY_NAME", socket.gethostname()),
            region=os.environ.get("PROBE_REGION", "未分组"),
            provider=os.environ.get("PROBE_PROVIDER", "自建"),
            interval_seconds=max(
                1.0, float(os.environ.get("PROBE_INTERVAL_SECONDS", "2"))
            ),
        )


class MetricsCollector:
    def __init__(self) -> None:
        rx, tx = net_counters()
        disk_io = psutil.disk_io_counters()
        self.previous_time = time.monotonic()
        self.previous_rx = rx
        self.previous_tx = tx
        self.previous_disk_read = disk_io.read_bytes if disk_io else 0
        self.previous_disk_write = disk_io.write_bytes if disk_io else 0
        self.last_tcp_scan = 0.0
        self.tcp_counts = {"established": 0, "listen": 0, "time_wait": 0}
        psutil.cpu_percent(interval=None)

    @staticmethod
    def _rate(current: int, previous: int, elapsed: float) -> int:
        if current < previous:
            return 0
        return max(0, round((current - previous) / elapsed))

    def _scan_tcp(self, now: float) -> dict[str, int]:
        if now - self.last_tcp_scan < 10:
            return self.tcp_counts

        counts = {"established": 0, "listen": 0, "time_wait": 0}
        try:
            for connection in psutil.net_connections(kind="tcp"):
                status = connection.status.upper()
                if status == "ESTABLISHED":
                    counts["established"] += 1
                elif status == "LISTEN":
                    counts["listen"] += 1
                elif status == "TIME_WAIT":
                    counts["time_wait"] += 1
        except (psutil.AccessDenied, PermissionError):
            pass
        self.last_tcp_scan = now
        self.tcp_counts = counts
        return counts

    def collect(self, config: AgentConfig, sequence: int) -> dict:
        wall_time = time.time()
        monotonic_time = time.monotonic()
        elapsed = max(monotonic_time - self.previous_time, 0.1)

        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        disk = psutil.disk_usage("/")
        net_rx, net_tx = net_counters()
        disk_io = psutil.disk_io_counters()
        loads = psutil.getloadavg() if hasattr(psutil, "getloadavg") else (0, 0, 0)

        disk_read = disk_io.read_bytes if disk_io else self.previous_disk_read
        disk_write = disk_io.write_bytes if disk_io else self.previous_disk_write
        used_memory = max(0, memory.total - memory.available)

        payload = {
            "type": "metrics",
            "schema_version": 1,
            "sequence": sequence,
            "timestamp": int(wall_time),
            "server_id": config.server_id,
            "data": {
                "cpu": {
                    "usage_percent": psutil.cpu_percent(interval=None),
                    "load_1": loads[0],
                    "load_5": loads[1],
                    "load_15": loads[2],
                },
                "memory": {
                    "used_mb": used_memory // MIB,
                    "total_mb": memory.total // MIB,
                    "usage_percent": memory.percent,
                    "swap_used_mb": swap.used // MIB,
                    "swap_total_mb": swap.total // MIB,
                },
                "disk": {
                    "used_mb": disk.used // MIB,
                    "total_mb": disk.total // MIB,
                    "usage_percent": disk.percent,
                    "read_bytes_sec": self._rate(
                        disk_read, self.previous_disk_read, elapsed
                    ),
                    "write_bytes_sec": self._rate(
                        disk_write, self.previous_disk_write, elapsed
                    ),
                },
                "network": {
                    "rx_bytes_sec": self._rate(net_rx, self.previous_rx, elapsed),
                    "tx_bytes_sec": self._rate(net_tx, self.previous_tx, elapsed),
                    "total_rx_bytes": net_rx,
                    "total_tx_bytes": net_tx,
                    "tcp_connections": self._scan_tcp(monotonic_time),
                },
                "uptime_seconds": max(0, int(wall_time - psutil.boot_time())),
            },
        }

        self.previous_time = monotonic_time
        self.previous_rx = net_rx
        self.previous_tx = net_tx
        self.previous_disk_read = disk_read
        self.previous_disk_write = disk_write
        return payload


def cpu_model() -> str:
    # platform.processor() only returns "x86_64"/"unknown" on most Linux distros.
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as cpuinfo:
            for line in cpuinfo:
                key, _, value = line.partition(":")
                if key.strip() in ("model name", "Model", "Hardware") and value.strip():
                    return value.strip()
    except OSError:
        pass
    return platform.processor() or platform.machine() or "Unknown CPU"


def auth_packet(config: AgentConfig) -> dict:
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    return {
        "type": "auth",
        "token": config.token,
        "server_id": config.server_id,
        "display_name": config.display_name,
        "hostname": socket.gethostname(),
        "region": config.region,
        "provider": config.provider,
        "tags": [],
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "cpu_model": cpu_model(),
        "cpu_cores": psutil.cpu_count(logical=True) or 1,
        "mem_total_mb": memory.total // MIB,
        "disk_total_mb": disk.total // MIB,
    }


async def send_metrics(
    websocket: websockets.ClientConnection,
    config: AgentConfig,
) -> None:
    collector = MetricsCollector()
    sequence = 0
    while True:
        await asyncio.sleep(config.interval_seconds)
        sequence += 1
        await websocket.send(json.dumps(collector.collect(config, sequence)))


async def receive_messages(websocket: websockets.ClientConnection) -> None:
    async for raw_message in websocket:
        message = json.loads(raw_message)
        if message.get("type") == "error":
            raise RuntimeError(f"Server rejected packet: {message.get('code')}")


async def run_session(
    config: AgentConfig,
    on_authenticated: Callable[[], None],
) -> None:
    async with websockets.connect(
        config.server_url,
        open_timeout=10,
        ping_interval=20,
        ping_timeout=10,
        max_size=64 * 1024,
        compression=None,
    ) as websocket:
        await websocket.send(json.dumps(auth_packet(config)))
        raw_response = await asyncio.wait_for(websocket.recv(), timeout=5)
        response = json.loads(raw_response)
        if response.get("type") != "auth_ack" or response.get("status") != "ok":
            raise RuntimeError(f"Authentication failed: {response}")

        print(f"Authenticated as {config.server_id}", flush=True)
        on_authenticated()
        sender = asyncio.create_task(send_metrics(websocket, config))
        receiver = asyncio.create_task(receive_messages(websocket))
        done, pending = await asyncio.wait(
            {sender, receiver}, return_when=asyncio.FIRST_EXCEPTION
        )
        for task in pending:
            task.cancel()
        for task in done:
            task.result()


async def run_forever(config: AgentConfig) -> None:
    backoff = 1.0

    # run_session always ends by raising, so reset once a session authenticates.
    def reset_backoff() -> None:
        nonlocal backoff
        backoff = 1.0

    while True:
        try:
            print(f"Connecting to {config.server_url}", flush=True)
            await run_session(config, reset_backoff)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - reconnect boundary
            delay = min(backoff, 60.0) + random.uniform(0, 1.0)
            print(f"Connection lost: {error}; retrying in {delay:.1f}s", flush=True)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, 60.0)


if __name__ == "__main__":
    asyncio.run(run_forever(AgentConfig.from_environment()))

