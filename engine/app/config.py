"""Node configuration, read from environment variables (see docs/00_CONTRACT.md section 2)."""
import os
from dataclasses import dataclass, field

VALID_NODES = ("mum", "hyd", "sin")


@dataclass
class Config:
    node_id: str = "mum"
    port: int = 8001
    peers: list[str] = field(default_factory=list)
    mode: str = "crdt"
    db_path: str = ""
    # When set, /admin/*, /sync and conflict resolution require the header X-Admin-Token.
    # Empty means open (local development and tests).
    admin_token: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        node_id = os.getenv("NODE_ID", "mum")
        peers = [p.strip() for p in os.getenv("PEERS", "").split(",") if p.strip()]
        return cls(
            node_id=node_id,
            port=int(os.getenv("PORT", "8001")),
            peers=peers,
            mode=os.getenv("MODE", "crdt"),
            db_path=os.getenv("DB_PATH", f"data/{node_id}.db"),
            admin_token=os.getenv("ADMIN_TOKEN", ""),
        )
