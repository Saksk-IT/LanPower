"""Record the client version at enrollment without replacing existing sessions."""
from alembic import op
import sqlalchemy as sa

revision = "0007_client_versions"
down_revision = "0006_gateway_commands"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("client_sessions", sa.Column("version", sa.String(32), nullable=False, server_default=""))
    op.add_column("client_sessions", sa.Column("protocol_version", sa.String(16), nullable=False, server_default="2"))


def downgrade() -> None:
    with op.batch_alter_table("client_sessions") as batch:
        batch.drop_column("protocol_version")
        batch.drop_column("version")
