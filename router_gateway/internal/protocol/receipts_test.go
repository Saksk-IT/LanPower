package protocol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func receiptCommand() Command {
	now := time.Now().Unix()
	return Command{CommandID: "00000000-0000-0000-0000-000000000001", Nonce: strings.Repeat("a", 32), IssuedAt: now, ExpiresAt: now + 45}
}

func TestReceiptsSurviveRestartAndNeverRepeatReservations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipts.json")
	store, err := OpenCommandStore(path)
	if err != nil {
		t.Fatal(err)
	}
	command := receiptCommand()
	if cached, err := store.Begin(command, time.Now()); err != nil || cached != nil {
		t.Fatal("first command not reserved", err)
	}
	store, err = OpenCommandStore(path)
	if err != nil {
		t.Fatal(err)
	}
	cached, err := store.Begin(command, time.Now())
	if err != nil || cached == nil || cached.OK || !strings.Contains(cached.Error, "outcome unknown") {
		t.Fatal("incomplete command repeated")
	}
	result := Result{CommandID: command.CommandID, OK: true, State: "waking"}
	if err := store.Complete(result); err != nil {
		t.Fatal(err)
	}
	store, err = OpenCommandStore(path)
	if err != nil {
		t.Fatal(err)
	}
	cached, err = store.Begin(command, time.Now())
	if err != nil || cached == nil || *cached != result {
		t.Fatal("existing result lost")
	}
	changed := command
	changed.CommandID = "00000000-0000-0000-0000-000000000002"
	if _, err := store.Begin(changed, time.Now()); err == nil {
		t.Fatal("nonce reused")
	}
	changed = command
	changed.Nonce = strings.Repeat("b", 32)
	if _, err := store.Begin(changed, time.Now()); err == nil {
		t.Fatal("ID reused with different nonce")
	}
}

func TestCorruptOrUnwritableReceiptsRefuseExecution(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipts.json")
	for _, data := range []string{"null", "invalid", `{"not-a-uuid":{"nonce":"invalid","expires_at":123}}`} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenCommandStore(path); err == nil {
			t.Fatal("corrupt receipts accepted")
		}
	}
	store, err := OpenCommandStore(filepath.Join(t.TempDir(), "missing", "receipts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Begin(receiptCommand(), time.Now()); err == nil {
		t.Fatal("reservation accepted without durable storage")
	}
}
