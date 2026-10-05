"""Account password login and stable native connections; preserve existing identities."""
from alembic import op
import sqlalchemy as sa

revision = "0010_accounts"
down_revision = "0009_automation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("account_password_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("web_sessions", sa.Column("auth_method", sa.String(16), nullable=False, server_default=""))
    op.create_table("account_connections",
        sa.Column("key_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_type", sa.String(16), nullable=False),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=True),
        sa.Column("client_id", sa.String(36), sa.ForeignKey("client_sessions.id"), nullable=True))
    op.create_index("ix_account_connections_owner_id", "account_connections", ["owner_id"])


def downgrade() -> None:
    op.drop_table("account_connections")
    op.drop_column("web_sessions", "auth_method")
    op.drop_column("users", "account_password_enabled")
