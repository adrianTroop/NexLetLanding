import AccessForm from './components/AccessForm'

export default function App() {
  return (
    <>
      <nav>
        <div className="wrap nav-in">
          <a href="#top" className="brand">
            <svg width="26" height="26" viewBox="0 0 200 200" aria-label="NexLet">
              <rect x="6" y="6" width="188" height="188" fill="none" stroke="#C9A961" strokeWidth="4" opacity="0.5" />
              <g fill="#C9A961">
                <rect x="58" y="46" width="10" height="108" />
                <rect x="132" y="46" width="10" height="108" />
                <path d="M68 46 L68 76 L132 154 L132 124 Z" />
              </g>
            </svg>
            <span className="brand-name">N<span className="x">ex</span>Let</span>
          </a>
          <a href="#access" className="nav-cta">Request access</a>
        </div>
      </nav>

      <header id="top">
        <div className="wrap hero-in hero-grid">
          <div>
            <div className="eyebrow">Private · By invitation</div>
            <h1>The transaction layer for <em><br />off-market luxury rentals.</em></h1>
            <p className="lead">The best houses in the Mediterranean and the Alps are never listed. They move between a small number of people, on trust, with nothing written down. We are building the rails underneath that market.</p>
            <div className="cta-row">
              <a href="#access" className="btn btn-p">Request access</a>
              <a href="#what" className="btn btn-s">What this is</a>
            </div>
            <div className="hero-meta"><span className="dot"></span><span>Mykonos first</span><span>·</span><span>Closed pilot, 2026</span></div>
          </div>
          <div className="hero-art">
            <div className="ph" aria-hidden="true">
              <div className="scr">
                <div className="bar"><span>9:41</span><span>NXL</span></div>
                <div className="pad">
                  <div className="top"><span className="ey">Selection · Marcus L.</span><span className="chip">PRIVATE</span></div>
                  <div className="card">
                    <div className="vl"><div className="th"></div><div><div className="nm">Villa Léthe</div><div className="mt">Agios Lazaros</div></div><div className="pr">€38k/wk</div></div>
                    <div className="vl"><div className="th"></div><div><div className="nm">Villa Aurora</div><div className="mt">Aleomandra</div></div><div className="pr">€31k/wk</div></div>
                    <div className="vl"><div className="th"></div><div><div className="nm">Casa Sereno</div><div className="mt">Kanalia</div></div><div className="pr">€26k/wk</div></div>
                  </div>
                  <div className="card">
                    <div className="ey">Sent by</div>
                    <div className="rw"><span className="l">Cycladic Estates</span><span className="v">Alexia P.</span></div>
                    <div className="rw"><span className="l">Held until</span><span className="v">Fri, 18:00</span></div>
                  </div>
                  <div className="btn-s2">Open selection</div>
                </div>
              </div>
            </div>
            <div className="float"><span className="d2"></span><div><div className="t">Marcus likes Villa Aurora.</div><div className="s">You'll know before he calls</div></div></div>
          </div>
        </div>
      </header>

      <section id="what">
        <div className="wrap">
          <div className="eyebrow">What this is</div>
          <h2>A private network for the people who <em>actually move these houses.</em></h2>
          <p className="sub">Not a portal. Nothing here is public, searchable or scrapeable. Access is granted, and every party on it is known.</p>
          <div className="cols">
            <div className="col"><div className="n">I</div><h3>Send</h3><p>Agents put a considered selection in front of a client — private, branded, and nothing like a thread full of photos.</p></div>
            <div className="col"><div className="n">II</div><h3>Control</h3><p>Owners decide who may see and market their house, and see exactly who has. No exposure they did not grant.</p></div>
            <div className="col"><div className="n">III</div><h3>Settle</h3><p>Terms, deposits and payment handled properly, through licensed partners — so the risk stops sitting on the agent.</p></div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="eyebrow">Who it is for</div>
          <h2>Invited, in two <em>groups.</em></h2>
          <div className="who">
            <div className="card"><div className="r">Agents</div><h3>The ones with the clients</h3><p>Keep your commission, your clients and your name. We supply the infrastructure, never the demand.</p></div>
            <div className="card"><div className="r">Owners</div><h3>The ones with the houses</h3><p>Stay off-market and stay in control — while the weeks that usually go empty stop going empty.</p></div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="eyebrow">Where</div>
          <h2>One market at a time, <em>properly.</em></h2>
          <p className="sub">We open with density in one market before going anywhere else. Our clients don't have a season — they have an itinerary, and it runs year-round.</p>
          <div className="markets">
            <span className="mk on">Mykonos · open</span>
            {['Ibiza', 'Marbella', 'Barcelona', 'St Tropez', 'Portofino', 'Monaco', 'Athens', 'Courchevel', 'Verbier', 'Zermatt', 'Gstaad', 'Miami', 'Tulum', 'Bali'].map((m) => (
              <span className="mk" key={m}>{m}</span>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="eyebrow">A glimpse</div>
          <h2>Three surfaces. <em>The rest opens with access.</em></h2>
          <p className="sub">What the client receives, what the owner governs, and how the money is handled — shown properly once you're in.</p>
          <div className="peek">
            <div className="pk">
              <div className="ph" aria-hidden="true">
                <div className="scr">
                  <div className="bar"><span>9:41</span><span>NXL</span></div>
                  <div className="pad">
                    <div className="top"><span className="ey">Your selection</span><span className="chip">3 HOUSES</span></div>
                    <div className="card">
                      <div className="vl"><div className="th"></div><div><div className="nm">Villa Léthe</div><div className="mt">Agios Lazaros</div></div></div>
                      <div className="vl"><div className="th"></div><div><div className="nm">Villa Aurora</div><div className="mt">Aleomandra</div></div></div>
                    </div>
                    <div className="card"><div className="ey">Held for you</div><div className="rw"><span className="l">Expires</span><span className="v">Friday</span></div></div>
                  </div>
                </div>
              </div>
              <div className="cap">The client</div>
            </div>
            <div className="pk">
              <div className="ph" aria-hidden="true">
                <div className="scr">
                  <div className="bar"><span>9:41</span><span>NXL</span></div>
                  <div className="pad">
                    <div className="top"><span className="ey">Villa Léthe</span><span className="chip">OFF-MARKET</span></div>
                    <div className="card">
                      <div className="ey">Who may market this house</div>
                      <div className="rw"><span className="l">Alexia P.</span><span className="v">Approved</span></div>
                      <div className="rw"><span className="l">Requests</span><span className="v" style={{ color: 'var(--gold)' }}>2 pending</span></div>
                    </div>
                    <div className="card"><div className="ey">Who has seen it</div><div className="rw"><span className="l">This month</span><span className="v">14 · all named</span></div></div>
                  </div>
                </div>
              </div>
              <div className="cap">The owner</div>
            </div>
            <div className="pk">
              <div className="ph" aria-hidden="true">
                <div className="scr">
                  <div className="bar"><span>9:41</span><span>NXL</span></div>
                  <div className="pad">
                    <div className="top"><span className="ey">Villa Léthe</span><span className="chip">CONTRACTED</span></div>
                    <div className="card">
                      <div className="ey">Agreement</div>
                      <div className="rw"><span className="l">Parties</span><span className="v">All three</span></div>
                      <div className="rw"><span className="l">Signed</span><span className="v" style={{ color: 'var(--gold)' }}>Complete</span></div>
                    </div>
                    <div className="card"><div className="ey">Deposit</div><div className="rw"><span className="l">Held</span><span className="v">Neutrally</span></div></div>
                  </div>
                </div>
              </div>
              <div className="cap">The money</div>
            </div>
          </div>
        </div>
      </section>

      <section className="access" id="access">
        <div className="wrap">
          <div className="eyebrow">Request access</div>
          <h2>Membership is <em>by invitation.</em></h2>
          <p className="sub">Tell us who you are and how you work in this market. We open seats market by market.</p>
          <AccessForm />
        </div>
      </section>

      <footer>
        <div className="wrap foot-in">
          <span>NexLet · 2026</span>
          <span>Private · By invitation</span>
        </div>
      </footer>
    </>
  )
}
