"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NearConnector, NearWalletBase, SignedMessage } from "@hot-labs/near-connect";
import { authenticateWallet, disconnectWallet, getAuthChallenge, getWalletSession, type WalletSession } from "../lib/api";

export type WalletAuthState = "disconnected" | "connected" | "authenticated" | "expired" | "failed";
type WalletContextValue = { accountId?: string; walletAccountId?: string; authState: WalletAuthState; network: "testnet"; ready: boolean; connecting: boolean; error?: string; wallet?: NearWalletBase; connect: () => Promise<void>; disconnect: () => Promise<void> };
const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function decodeNonce(value: string): Uint8Array { const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
export function walletStatusLabel(state: WalletAuthState): string { return { disconnected: "Not connected", connected: "Connected — authentication required", authenticated: "Authenticated", expired: "Session expired — reconnect", failed: "Authentication failed" }[state]; }

export function NearWalletProvider({ children }: { children: ReactNode }) {
  const connectorRef = useRef<NearConnector | undefined>(undefined);
  const [session, setSession] = useState<WalletSession>();
  const [wallet, setWallet] = useState<NearWalletBase>();
  const [walletAccountId, setWalletAccountId] = useState<string>();
  const [authState, setAuthState] = useState<WalletAuthState>("disconnected");
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void (async () => {
      const [{ NearConnector }, existing] = await Promise.all([import("@hot-labs/near-connect"), getWalletSession().catch(() => undefined)]);
      const connector = new NearConnector({ network: "testnet", features: { testnet: true, signMessage: true, signAndSendTransaction: true } });
      await connector.whenManifestLoaded;
      if (!active) return;
      connectorRef.current = connector;
      connector.on("wallet:signIn", (event) => { if (active) { const accountId = event.accounts[0]?.accountId; setWallet(event.wallet); setWalletAccountId(accountId); setSession(undefined); setAuthState(accountId ? "connected" : "disconnected"); } });
      connector.on("wallet:signOut", () => { if (active) { setWallet(undefined); setWalletAccountId(undefined); setSession(undefined); setAuthState("disconnected"); } });
      const connected = await connector.getConnectedWallet().catch(() => undefined);
      const connectedAccountId = connected?.accounts[0]?.accountId;
      if (connectedAccountId) { setWallet(connected.wallet); setWalletAccountId(connectedAccountId); if (existing?.accountId === connectedAccountId) { setSession(existing); setAuthState("authenticated"); } else setAuthState("connected"); }
      setReady(true);
    })().catch((cause) => { if (active) { setError(cause instanceof Error ? cause.message : "NEAR wallet support could not load."); setAuthState("failed"); setReady(true); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session?.accountId) return undefined;
    const timer = window.setInterval(() => { void getWalletSession().then((current) => { if (current.accountId !== session.accountId) { setSession(undefined); setAuthState("expired"); } }).catch(() => { setSession(undefined); setAuthState("expired"); }); }, 30_000);
    return () => window.clearInterval(timer);
  }, [session?.accountId]);

  const connect = useCallback(async () => {
    const connector = connectorRef.current; if (!connector) throw new Error("NEAR wallet is still loading");
    setConnecting(true); setError(undefined);
    try {
      const challenge = await getAuthChallenge();
      let signedMessage: SignedMessage | undefined;
      const signed = new Promise<SignedMessage>((resolve) => connector.once("wallet:signInAndSignMessage", (event) => { const item = event.accounts[0]?.signedMessage; if (item) resolve(item); }));
      const connectedWallet = await connector.connect({ signMessageParams: { message: challenge.message, recipient: challenge.recipient, nonce: decodeNonce(challenge.nonce) } });
      setWallet(connectedWallet);
      setWalletAccountId(undefined);
      setAuthState("connected");
      signedMessage = await Promise.race([signed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000))]);
      if (!signedMessage) signedMessage = await connectedWallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: decodeNonce(challenge.nonce), network: "testnet" });
      setWalletAccountId(signedMessage.accountId);
      const authenticated = await authenticateWallet({ challengeId: challenge.challengeId, signedMessage });
      setSession(authenticated);
      setAuthState("authenticated");
    } catch (cause) { setSession(undefined); setAuthState("failed"); setError(cause instanceof Error ? cause.message : "Wallet connection was rejected."); throw cause; } finally { setConnecting(false); }
  }, []);

  const disconnect = useCallback(async () => { const connector = connectorRef.current; try { if (connector) await connector.disconnect(wallet); await disconnectWallet(); } finally { setWallet(undefined); setWalletAccountId(undefined); setSession(undefined); setAuthState("disconnected"); } }, [wallet]);
  const value = useMemo<WalletContextValue>(() => ({ accountId: session?.accountId, walletAccountId, authState, network: "testnet", ready, connecting, error, wallet, connect, disconnect }), [session, walletAccountId, authState, ready, connecting, error, wallet, connect, disconnect]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useNearWallet(): WalletContextValue { const value = useContext(WalletContext); if (!value) throw new Error("useNearWallet must be used within NearWalletProvider"); return value; }
