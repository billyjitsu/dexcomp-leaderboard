"use client";

import { useEffect } from "react";

// Static page shell. board-client.ts fills it in with DOM methods, so React renders it
// once and never re-renders (no state here).
export function Board({ view }: { view: "public" | "admin" }) {
  useEffect(() => {
    void import("./board-client").then((m) => m.start(view));
  }, [view]);
  const admin = view === "admin";
  const cols = admin ? 11 : 4;
  const nbsp = " ";

  return (
    <>
      <header className="topbar">
        <svg viewBox="0 0 36 42" fill="none" aria-hidden="true">
          <path d="M14.8015 14.6354V0H6.34352L0 20.9476H5.07482L0 37.7058H14.8015V27.2688L27.4891 42L36 29.3266L19.0841 20.9476H14.8015H25.3739L31.7172 0H23.2593L14.8015 14.6354Z" fill="currentColor" />
        </svg>
        <span className="title">Spot Trading Competition</span>
        {admin && <span className="tag tag-bad">Admin</span>}
        <span className="tag" id="mode-tag" hidden></span>
        {admin && (
          <input className="search topbar-right admin-name" id="admin-name" type="text" placeholder="Your name (for the log)" maxLength={40} autoComplete="name" aria-label="Your name, recorded with admin actions" />
        )}
      </header>

      <main className="page-content">
        {/* Layer 1: how close is the round to unlocking prizes */}
        <section className="card" aria-labelledby="prize-label">
          <div className="hero">
            <div className="hero-row">
              <div>
                <div className="eyebrow" id="prize-label">Prize pool unlocked</div>
                <div className="big" id="prize-unlocked">{nbsp}</div>
              </div>
              <div className="hero-right">
                <select className="round-select" id="round-select" aria-label="Choose round" hidden></select>
                <div className="countdown" id="countdown" hidden>
                  <span className="eyebrow" id="cd-label"></span>
                  <div className="cd-boxes" role="timer" aria-live="off">
                    <div className="cd-box"><span className="cd-num" id="cd-d">0</span><span className="cd-unit">Days</span></div>
                    <div className="cd-box"><span className="cd-num" id="cd-h">0</span><span className="cd-unit">Hrs</span></div>
                    <div className="cd-box"><span className="cd-num" id="cd-m">0</span><span className="cd-unit">Min</span></div>
                    <div className="cd-box"><span className="cd-num" id="cd-s">0</span><span className="cd-unit">Sec</span></div>
                  </div>
                </div>
                <div className="eyebrow" id="round-label">{nbsp}</div>
                <div className="muted next" id="next-text">{nbsp}</div>
              </div>
            </div>
            <div className="progress" id="progress" role="progressbar" aria-label="Competition volume toward milestones">
              <div className="progress-fill" id="progress-fill"></div>
            </div>
          </div>
          <div className="stats">
            <div className="stat"><span className="eyebrow">Competition volume</span><span className="stat-value" id="s-volume">{nbsp}</span></div>
            <div className="stat"><span className="eyebrow">Ranked traders</span><span className="stat-value" id="s-ranked">{nbsp}</span></div>
            <div className="stat"><span className="eyebrow">{admin ? "Counted trades" : "Paid places"}</span><span className="stat-value" id="s-paid">{nbsp}</span></div>
          </div>
        </section>

        {admin && (
          <>
            {/* Admin: round lifecycle (review -> final), manual refresh and payout export */}
            <section className="card round-admin" aria-labelledby="round-admin-title">
              <div className="table-head">
                <div>
                  <h2 id="round-admin-title">Round status</h2>
                  <p className="detail-note" id="round-admin-text"></p>
                </div>
                <div className="round-admin-actions">
                  <button className="btn" id="refresh-now" type="button">Refresh now</button>
                  <button className="btn" id="round-finalize" type="button" hidden>Finalize round</button>
                  <button className="btn" id="round-reopen" type="button" hidden>Reopen for review</button>
                  <button className="btn" id="payout-csv" type="button">Download payout CSV</button>
                </div>
              </div>
            </section>

            {/* Admin: rounds ("sprints") */}
            <section className="card card-table" aria-labelledby="rounds-title">
              <div className="table-head">
                <h2 id="rounds-title">Rounds</h2>
              </div>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr><th className="left">Id</th><th className="left">Name</th><th className="left">Start</th><th className="left">End</th><th className="left">Status</th><th>Opt-in</th><th className="left"></th></tr>
                  </thead>
                  <tbody id="rounds-rows"></tbody>
                </table>
              </div>
              <form className="round-form" id="round-form">
                <label>Id<input className="search" id="rf-id" required maxLength={40} pattern="[a-z0-9\-]{1,40}" placeholder="round-1" autoComplete="off" spellCheck={false} /></label>
                <label>Name<input className="search" id="rf-name" required maxLength={80} placeholder="Round 1" autoComplete="off" /></label>
                <label>Start (your time)<input className="search" id="rf-start" type="datetime-local" required /></label>
                <label>End (your time)<input className="search" id="rf-end" type="datetime-local" required /></label>
                <label className="round-form-check">
                  <span><input id="rf-optin" type="checkbox" defaultChecked /> Require opt-in</span>
                  <small>Off = every wallet counts</small>
                </label>
                <div className="round-form-actions">
                  <button className="btn" id="rf-submit" type="submit">Create round</button>
                  <button className="btn" id="rf-cancel" type="button" hidden>Cancel</button>
                </div>
              </form>
              <p className="detail-note pad" id="rounds-note">
                Each round needs its own opt-in. Rounds that have started can&apos;t be deleted; edit them, or finalize them once they end.
              </p>
            </section>

            {/* Admin: per-pool totals for reporting */}
            <section className="card card-table" aria-labelledby="pool-report-title">
              <div className="table-head">
                <h2 id="pool-report-title">Pool activity</h2>
                <button className="btn" id="pool-csv" type="button">Download CSV</button>
              </div>
              <div className="table-wrap">
                <table className="admin-table pool-report">
                  <thead>
                    <tr><th className="left">Pool</th><th>Counted</th><th>All activity</th><th>Share</th><th>Trades</th><th>Traders</th><th>Net buyers</th><th>Net sellers</th><th>Buys</th><th>Sells</th><th>Net flow</th></tr>
                  </thead>
                  <tbody id="pool-report"></tbody>
                </table>
              </div>
              <p className="detail-note pad" id="pool-report-note"></p>
            </section>
          </>
        )}

        {/* Layer 2: leaderboard + find my wallet */}
        <section className="card card-table" aria-labelledby="board-title">
          <div className="table-head">
            <h2 id="board-title">Leaderboard</h2>
            {admin ? (
              <>
                <input className="search note" id="admin-note" type="text" placeholder="Note for manual opt-ins (ticket #)" maxLength={200} autoComplete="off" aria-label="Note for manual opt-ins" />
                <input className="search" id="search" type="search" placeholder="Find a wallet (0x...)" autoComplete="off" spellCheck={false} maxLength={42} aria-label="Find a wallet" />
              </>
            ) : (
              <div className="wallet-box">
                <button className="btn-connect" id="connect" type="button" aria-haspopup="menu" aria-expanded="false">Connect wallet</button>
                <div className="wallet-menu" id="wallet-menu" role="menu" hidden></div>
              </div>
            )}
          </div>
          {!admin && <div className="join-banner" id="join-banner" hidden></div>}
          <div className="table-wrap">
            <table className={admin ? "admin-table" : "board"}>
              <thead>
                {admin ? (
                  <tr><th>Rank</th><th className="left">Wallet</th><th>Volume</th><th>Trades</th><th>Fees paid</th><th>Indexer USD</th><th>Share</th><th>Reward</th><th className="left">Joined</th><th>Not counted</th><th className="left">Flags</th></tr>
                ) : (
                  <tr><th>Rank</th><th className="left">Name</th><th className="left">Volume</th><th>Reward</th></tr>
                )}
              </thead>
              <tbody id="rows">
                <tr className="skeleton"><td colSpan={cols}><div className="bar w60"></div></td></tr>
                <tr className="skeleton"><td colSpan={cols}><div className="bar w45"></div></td></tr>
                <tr className="skeleton"><td colSpan={cols}><div className="bar w52"></div></td></tr>
              </tbody>
            </table>
          </div>
          {admin && <div className="table-foot"><button className="btn" id="toggle-all" type="button" hidden>Show all wallets</button></div>}
        </section>

        {admin && (
          <section className="card card-table" aria-labelledby="log-title">
            <div className="table-head"><h2 id="log-title">Admin activity</h2></div>
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th className="left">When</th><th className="left">Who</th><th className="left">Action</th><th className="left">Round</th><th className="left">Wallet</th><th className="left">Detail</th></tr>
                </thead>
                <tbody id="log-rows"></tbody>
              </table>
            </div>
          </section>
        )}

        {/* Layer 3: rules, pools */}
        <section className="card">
          <details>
            <summary>How volume is counted</summary>
            <div className="rules" id="rules"></div>
          </details>
        </section>
        <section className="card">
          <details>
            <summary>Eligible pools</summary>
            <div className="pools" id="pools"></div>
          </details>
        </section>

        <p className="footnote" id="footnote"></p>
      </main>
    </>
  );
}
