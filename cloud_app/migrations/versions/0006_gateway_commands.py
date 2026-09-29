"""V2 Wake Gateway commands, separately addressed to gateway and Windows."""
from alembic import op
import sqlalchemy as sa

revision = "0006_gateway_commands"
down_revision = "0005_client_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("gateway_commands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("gateway_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("target_device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("nonce", sa.String(32), nullable=False, unique=True),
        sa.Column("issued_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("delivered_at", sa.Integer()),
        sa.Column("result_ok", sa.Boolean()),
        sa.Column("result_state", sa.String(24)),
        sa.Column("error", sa.String(160)))
    op.create_index("ix_gateway_commands_gateway_id", "gateway_commands", ["gateway_id"])
    op.create_index("ix_gateway_commands_target_device_id", "gateway_commands", ["target_device_id"])


def downgrade() -> None:
    op.drop_table("gateway_commands")
