(() => {
  "use strict";

  // ========== Mobile nav toggle ==========
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }),
    );
  }

  // ========== Copy command on tap ==========
  const toast = document.getElementById("toast");
  let toastTimer = null;
  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }
  };

  document.querySelectorAll("[data-copy]").forEach((el) => {
    const cmd = el.getAttribute("data-copy") || "";
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `Copy command ${cmd}`);

    const copyCommand = async () => {
      const ok = await copyText(cmd);
      showToast(ok ? `Copied: ${cmd}` : "Copy failed");
    };

    el.addEventListener("click", copyCommand);
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      copyCommand();
    });
  });

  // ========== Scroll reveal ==========
  if (
    "IntersectionObserver" in window &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    const targets = document.querySelectorAll(
      ".feature-card, .step, .cmd-block, .sec-row, .sidebar-card, .cta-box",
    );
    targets.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(16px)";
      el.style.transition = "opacity 0.5s ease, transform 0.5s ease";
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const parent = e.target.parentElement;
            const siblings = parent
              ? Array.from(parent.children).filter((c) =>
                  Array.from(targets).includes(c),
                )
              : [];
            const idx = siblings.indexOf(e.target);
            const stagger = idx >= 0 ? idx * 60 : 0;
            setTimeout(() => {
              e.target.style.opacity = "1";
              e.target.style.transform = "none";
            }, stagger);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.08 },
    );
    targets.forEach((el) => io.observe(el));
  }

  // ========== Live demo chat animation ==========
  const chat = document.getElementById("demo-chat");
  if (!chat) return;

  // Respect reduced motion
  const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Demo scenarios that cycle
  const demos = [
    // DEMO 1: Trade flow
    [
      { type: "user", text: "/up BTC 71000 10 100", delay: 600 },
      { type: "typing", delay: 900 },
      {
        type: "bot-card",
        delay: 0,
        html: `
          <div class="bubble-header">Trade preview</div>
          <div class="bubble-asset">BTC above $71,000</div>
          <div class="bubble-expiry">Expiry: 14:32 UTC (9 min) · BTC: $70,234</div>
          <div class="bubble-data">
            <div><span>Premium</span><strong>22 dUSDC</strong></div>
            <div><span>Max payout</span><strong>100 dUSDC</strong></div>
            <div><span>Net if correct</span><strong class="profit">+78 dUSDC</strong></div>
            <div><span>Implied prob</span><strong>22%</strong></div>
          </div>
          <div class="bubble-ai">BTC is 1.1% below strike. 22% implied probability of closing above.</div>
          <div class="bubble-actions">
            <span class="kb-confirm" id="demo-confirm">Confirm ✓</span>
            <span class="kb-cancel">Cancel ✗</span>
          </div>`,
      },
      { type: "tap-confirm", delay: 1400 },
      { type: "typing", delay: 800 },
      {
        type: "bot-card",
        delay: 0,
        html: `
          <div class="bubble-header" style="color:var(--green-600)">Position opened</div>
          <div class="bubble-asset">BTC above $71,000</div>
          <div class="bubble-data">
            <div><span>Premium paid</span><strong>22 dUSDC</strong></div>
            <div><span>Max payout</span><strong>100 dUSDC</strong></div>
            <div><span>Expiry</span><strong>14:32 UTC</strong></div>
            <div><span>Tx</span><strong style="color:var(--cyan)">0x7a3f…e91b</strong></div>
          </div>
          <div class="bubble-ai">Position is live. You'll get a DM when it settles.</div>`,
      },
      { type: "pause", delay: 3000 },
    ],
    // DEMO 2: Wallet creation
    [
      { type: "user", text: "/wallet create", delay: 600 },
      { type: "typing", delay: 1200 },
      {
        type: "bot-card",
        delay: 0,
        html: `
          <div class="bubble-header" style="color:var(--green-600)">Wallet created</div>
          <div class="bubble-data">
            <div><span>Address</span><strong style="color:var(--cyan)">0x8b2c…4f1a</strong></div>
            <div><span>SUI (gas)</span><strong>0.1 SUI</strong></div>
            <div><span>dUSDC</span><strong>1,000 dUSDC</strong></div>
            <div><span>Network</span><strong>Testnet</strong></div>
          </div>
          <div class="bubble-ai">Wallet encrypted with AES-256-GCM. Only you hold the keys.</div>`,
      },
      { type: "pause", delay: 3000 },
    ],
    // DEMO 3: Check balance
    [
      { type: "user", text: "/balance", delay: 600 },
      { type: "typing", delay: 700 },
      {
        type: "bot-card",
        delay: 0,
        html: `
          <div class="bubble-header">Balance</div>
          <div class="bubble-data">
            <div><span>SUI</span><strong>0.087 SUI</strong></div>
            <div><span>dUSDC (wallet)</span><strong>456 dUSDC</strong></div>
            <div><span>dUSDC (trading)</span><strong>544 dUSDC</strong></div>
            <div><span>Open positions</span><strong>2</strong></div>
          </div>
          <div class="bubble-ai">Win rate: 67% · Streak: 2 wins</div>`,
      },
      { type: "pause", delay: 3000 },
    ],
  ];

  let currentDemo = 0;
  let running = false;

  function createTyping() {
    const el = document.createElement("div");
    el.className = "typing-indicator";
    el.innerHTML = "<span></span><span></span><span></span>";
    return el;
  }

  function createUserBubble(text) {
    const el = document.createElement("div");
    el.className = "bubble user";
    el.innerHTML = `<code>${text}</code>`;
    return el;
  }

  function createBotCard(html) {
    const el = document.createElement("div");
    el.className = "bubble bot";
    el.innerHTML = html;
    return el;
  }

  function clearChat() {
    chat.innerHTML = "";
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function playDemo(steps) {
    for (const step of steps) {
      if (!running) return;

      if (step.delay > 0) await wait(step.delay);

      switch (step.type) {
        case "user": {
          const bubble = createUserBubble(step.text);
          chat.appendChild(bubble);
          chat.scrollTop = chat.scrollHeight;
          break;
        }
        case "typing": {
          const typing = createTyping();
          chat.appendChild(typing);
          chat.scrollTop = chat.scrollHeight;
          await wait(step.delay || 800);
          typing.remove();
          break;
        }
        case "bot-card": {
          const card = createBotCard(step.html);
          chat.appendChild(card);
          chat.scrollTop = chat.scrollHeight;
          break;
        }
        case "tap-confirm": {
          await wait(step.delay || 1000);
          const btn = chat.querySelector("#demo-confirm");
          if (btn) {
            btn.classList.add("active");
            await wait(300);
          }
          break;
        }
        case "pause": {
          await wait(step.delay || 2000);
          break;
        }
      }
    }
  }

  async function runLoop() {
    running = true;
    while (running) {
      clearChat();
      await wait(400);
      await playDemo(demos[currentDemo]);
      currentDemo = (currentDemo + 1) % demos.length;
      // Brief blank between demos
      await wait(600);
    }
  }

  // Start when the phone is visible (or immediately if reduced motion — show static)
  if (prefersReduced) {
    // Show the first demo statically
    const firstDemo = demos[0];
    const userStep = firstDemo.find((s) => s.type === "user");
    const botStep = firstDemo.find((s) => s.type === "bot-card");
    if (userStep) chat.appendChild(createUserBubble(userStep.text));
    if (botStep) chat.appendChild(createBotCard(botStep.html));
  } else {
    // Start on intersection
    const phoneEl = chat.closest(".phone");
    if ("IntersectionObserver" in window && phoneEl) {
      const obs = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && !running) {
            runLoop();
            obs.disconnect();
          }
        },
        { threshold: 0.3 },
      );
      obs.observe(phoneEl);
    } else {
      runLoop();
    }
  }
})();
