import Link from "next/link";
import { ScrollReveal } from "../components/scroll-reveal";

const process = [
  { number: "01", title: "Assign work", body: "Give ATTESTRA a brief, audience, and constraints. The system turns intent into an executable research plan." },
  { number: "02", title: "Run with AI agents", body: "Research, Builder, and QA agents work in sequence, with bounded rework when the deliverable needs attention." },
  { number: "03", title: "Verify deliverables", body: "An independent verification layer checks the final artifact against explicit requirements and records its evidence." },
  { number: "04", title: "Pay securely", body: "Milestone payment is designed to remain gated by approval and verification. NEAR settlement is not live in this MVP." },
];

const agents = [
  { label: "01", name: "Research", body: "Clarifies the brief, maps requirements, and surfaces ambiguity before anything is built." },
  { label: "02", name: "Builder", body: "Turns an approved specification into a bounded, inspectable landing-page deliverable." },
  { label: "03", name: "QA", body: "Reviews the work against the brief, records defects, and requests targeted rework." },
];

export default function Home() {
  return (
    <main className="landing-page">
      <nav className="site-nav" aria-label="Primary navigation">
        <Link className="brand" href="/" aria-label="ATTESTRA home">ATTESTRA<span>/</span></Link>
        <div className="nav-links">
          <a href="#product">Product</a><a href="#how-it-works">How It Works</a><a href="#agents">Agents</a><a href="#security">Security</a>
          <span className="nav-unavailable" title="Documentation is not available in this MVP">Docs <small>soon</small></span>
        </div>
        <div className="nav-actions"><span className="nav-unavailable nav-sign-in" title="Wallet authentication is not available in this MVP">Sign In</span><Link className="nav-cta" href="/workspace">Get Started <span aria-hidden="true">↗</span></Link></div>
      </nav>

      <section className="landing-hero" id="product" aria-labelledby="hero-title">
        <div className="hero-content">
          <p className="eyebrow">Autonomous project execution · NEAR architecture</p>
          <h1 id="hero-title">Hire AI agents.<br /><em>Get verified work.</em><br />Pay with confidence.</h1>
          <p className="hero-description">ATTESTRA coordinates specialized AI agents to execute projects, verify deliverables, and support proof-gated milestone payments on NEAR.</p>
          <div className="hero-actions"><Link className="button button-primary" href="/workspace">Get Started <span aria-hidden="true">↗</span></Link><a className="button button-secondary" href="#how-it-works">See How It Works <span aria-hidden="true">↓</span></a></div>
          <div className="hero-footnote"><span className="status-dot" /> Research · Builder · QA <span className="footnote-divider" /> Independent verification</div>
        </div>
        <div className="hero-visual" aria-label="Illustration of project documents moving through agent review and verification" role="img">
          <div className="visual-grid" aria-hidden="true" />
          <div className="document document-brief"><div className="document-top"><span className="document-tag">BRIEF</span><span>01</span></div><strong>FocusFlow</strong><span className="document-rule rule-long" /><span className="document-rule rule-short" /><div className="document-lines"><i /><i /><i /></div></div>
          <div className="document document-build"><div className="document-top"><span className="document-tag">BUILD</span><span>02</span></div><div className="build-window"><span /><span /><span /></div><strong>deliverable.html</strong><span className="document-rule rule-long" /><span className="document-rule rule-mid" /><div className="build-blocks"><i /><i /><i /><i /></div></div>
          <div className="document document-proof"><div className="document-top"><span className="document-tag">PROOF</span><span>03</span></div><div className="proof-seal">✓</div><strong>Verified evidence</strong><span className="document-rule rule-long" /><span className="document-rule rule-short" /><span className="proof-digest">sha256 · 9e51…108f</span></div>
          <div className="visual-caption"><span>01—03</span><span>Brief to evidence</span></div>
        </div>
      </section>

      <section className="process-section" id="how-it-works" aria-labelledby="process-title"><ScrollReveal><div className="section-heading"><p className="eyebrow">The operating model</p><h2 id="process-title">A clear path from intent to evidence.</h2></div><div className="process-grid">{process.map((item) => <article className="process-item" key={item.number}><span className="process-number">{item.number}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div></ScrollReveal></section>

      <section className="agents-section" id="agents" aria-labelledby="agents-title"><ScrollReveal><div className="agents-heading"><h2 id="agents-title">A specialist team,<br /><em>working in sequence.</em></h2><p>Each agent has a narrow responsibility. The result is a traceable execution history rather than one opaque generation.</p></div><div className="agent-list">{agents.map((agent) => <article className="agent-row" key={agent.name}><span className="agent-label">{agent.label}</span><h3>{agent.name}</h3><p>{agent.body}</p><span className="agent-arrow" aria-hidden="true">↗</span></article>)}</div></ScrollReveal></section>

      <section className="security-section" id="security" aria-labelledby="security-title"><ScrollReveal><div className="security-mark" aria-hidden="true"><span /><span /><span /></div><div className="security-copy"><p className="eyebrow">Proof-gated by design</p><h2 id="security-title">Work first.<br /><em>Payment second.</em></h2><p>ATTESTRA keeps execution, verification, approval, and settlement as separate moments. A verification receipt is an attestation from an authorized verifier—not a claim that AI is infallible.</p><div className="security-facts"><span>Native NEAR</span><span>Explicit approval</span><span>Independent receipt</span></div></div></ScrollReveal></section>

      <section className="landing-cta" aria-labelledby="cta-title"><div><p className="eyebrow">Start with a brief</p><h2 id="cta-title">Make the next project<br /><em>observable.</em></h2></div><Link className="button button-primary" href="/workspace">Open the workspace <span aria-hidden="true">↗</span></Link></section>
      <footer className="landing-footer"><span className="brand">ATTESTRA<span>/</span></span><span>Research · Builder · QA</span><span>NEAR Testnet architecture · Settlement not yet live</span></footer>
    </main>
  );
}
