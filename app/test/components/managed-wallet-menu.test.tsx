import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * THE WAY OUT OF CUSTODY.
 *
 * Atelier holds a managed worker's keys, and says so on every screen that
 * mentions the wallet. `linkOwnWallet` — the daemon route that hands the
 * account its own keys, history following — has existed since the Telegram
 * bot's /link, and the client function was exported this whole time with
 * nothing in the app calling it. So the honest answer to "how do I stop you
 * holding my keys" was "you cannot, from here".
 *
 * It moves money: the switch sweeps this wallet to the new address first, or
 * the balance is stranded somewhere nobody uses. Somebody should read that
 * before it happens.
 */

const linkOwnWallet = vi.fn();
vi.mock("@/lib/atelier/worker", () => ({
  linkOwnWallet: (i: unknown) => linkOwnWallet(i),
  forgetWorker: vi.fn(),
}));

let connected: string | null = null;
const connectWallet = vi.fn();
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({
    wallet: { isConnected: !!connected, address: connected },
    connectWallet,
  }),
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const { ManagedWalletMenu } = await import("@/components/atelier/managed-wallet-menu");

const WORKER = {
  id: "w1",
  handle: "cdev",
  address: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423",
  mode: "managed" as const,
  balance: "1.02",
};
const MY_WALLET = "0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41";

function renderMenu() {
  return render(
    <MemoryRouter>
      <ManagedWalletMenu
        worker={WORKER as never}
        onRefresh={vi.fn()}
        refreshing={false}
        onSignOut={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  connected = null;
  linkOwnWallet.mockResolvedValue({ ...WORKER, mode: "own", address: MY_WALLET });
});

describe("leaving custody", () => {
  it("offers the way out at all", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/use my own wallet/i)).toBeInTheDocument();
  });

  it("says the balance moves before it moves it", async () => {
    connected = MY_WALLET;
    renderMenu();
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText(/use my own wallet/i));

    expect(await screen.findByText(/anything in this wallet is sent there first/i)).toBeInTheDocument();
    expect(linkOwnWallet).not.toHaveBeenCalled();
  });

  it("switches to the connected wallet when confirmed", async () => {
    connected = MY_WALLET;
    renderMenu();
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText(/use my own wallet/i));
    await userEvent.click(await screen.findByRole("button", { name: /switch to it/i }));

    await waitFor(() =>
      expect(linkOwnWallet).toHaveBeenCalledWith({ workerId: "w1", address: MY_WALLET }),
    );
  });

  it("asks for a wallet before a destination, rather than a typed address", async () => {
    // A typo that is still a valid address cannot be caught by validation, and
    // this sweeps a balance to whatever it is given.
    renderMenu();
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText(/use my own wallet/i));
    await userEvent.click(await screen.findByRole("button", { name: /connect a wallet/i }));

    expect(connectWallet).toHaveBeenCalled();
    expect(linkOwnWallet).not.toHaveBeenCalled();
  });

  it("can be backed out of", async () => {
    connected = MY_WALLET;
    renderMenu();
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(await screen.findByText(/use my own wallet/i));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /switch to it/i })).not.toBeInTheDocument(),
    );
    expect(linkOwnWallet).not.toHaveBeenCalled();
  });
});
