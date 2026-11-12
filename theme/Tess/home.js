// Tess Music — Direction 1: Apple Music Listen Now
(async function tessHome() {
  window.__tessHome?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  window.__tessHome = {
    dispose: () => disposers.splice(0).reverse().forEach((fn) => {
      try { fn(); } catch {}
    })
  };

  const isHome = () => {
    const p = Spicetify.Platform?.History?.location?.pathname || "";
    return p === "/" || p === "/home";
  };

  async function getFirstName() {
    try {
      const u = await Spicetify.Platform?.UserAPI?.getUser?.();
      const full = u?.name || u?.displayName || u?.username;
      if (full && typeof full === "string") return full.trim().split(/\s+/)[0];
    } catch {}
    const widget = document.querySelector("[data-testid=\"user-widget-link\"], [data-testid=\"user-widget-dropdown-button\"]");
    const label = widget?.getAttribute("aria-label") || widget?.textContent?.trim();
    if (label && !/profile|account/i.test(label)) return label.split(/\s+/)[0];
    return "Krish";
  }

  function getGreetingDetails(firstName) {
    const now = new Date();
    const dateEyebrow = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    }).toUpperCase();

    const hour = now.getHours();
    let salutation = "Good evening";
    if (hour >= 4 && hour < 12) salutation = "Good morning";
    else if (hour >= 12 && hour < 17) salutation = "Good afternoon";

    return {
      dateEyebrow,
      greeting: salutation + ", " + firstName
    };
  }

  function getHeroCardData() {
    const shelves = Array.from(document.querySelectorAll("[data-testid=\"component-shelf\"]"));
    if (!shelves.length) return null;

    let targetShelf = shelves.find((s) => {
      const text = (s.querySelector("h2, [data-encore-id=\"listRowTitle\"]")?.textContent || "").toLowerCase();
      return text.includes("top mix") || text.includes("made for");
    });
    if (!targetShelf) targetShelf = shelves[0];

    const card = targetShelf.querySelector("[data-encore-id=\"card\"], .main-card-cardContainer");
    if (!card) return null;

    const img = card.querySelector("img");
    const playBtn = card.querySelector("button[aria-label*=\"Play\"]");
    const playLabel = playBtn?.getAttribute("aria-label") || "";
    const cleanedTitleFromBtn = playLabel.replace(/^Play\s+/i, "").trim();

    const textNodes = Array.from(card.querySelectorAll("a, span, p"))
      .map((e) => e.textContent.trim())
      .filter(Boolean);
    const uniqueTexts = Array.from(new Set(textNodes));

    let title = cleanedTitleFromBtn;
    if (!title && uniqueTexts.length) title = uniqueTexts[0];

    const subtitle = uniqueTexts.find(
      (t) => t !== title && t !== "Play" && !t.startsWith("Play ") && !t.includes("•")
    ) || "Curated mix tailored to your listening";

    const link = card.querySelector("a[href]")?.getAttribute("href") || "";
    let uri = card.getAttribute("data-uri") || "";
    if (!uri && link) {
      uri = link.startsWith("spotify:") ? link : "spotify:" + link.replace(/^\//, "").replace(/\//g, ":");
    }

    return {
      shelfTitle: targetShelf.querySelector("h2, [data-encore-id=\"listRowTitle\"]")?.textContent?.trim() || "Featured",
      title,
      subtitle,
      link,
      uri,
      imgSrc: img?.src || ""
    };
  }

  function renderMasthead(firstName) {
    const chipsWrapper = document.querySelector("button[data-encore-id=\"chip\"]")?.closest("div.w2WpffC3sNc7GAWa4JVW")
      || document.querySelector("section[data-testid=\"home-page\"]")?.previousElementSibling;
    const targetParent = chipsWrapper?.parentElement || document.querySelector("main > div");
    if (!targetParent) return;

    let masthead = document.getElementById("tess-home-masthead");
    const details = getGreetingDetails(firstName);

    if (!masthead || !masthead.isConnected) {
      masthead?.remove();
      masthead = document.createElement("div");
      masthead.id = "tess-home-masthead";
      masthead.className = "contentSpacing";
      masthead.innerHTML = `<div class="tess-masthead-eyebrow"></div><h1 class="tess-masthead-greeting"></h1>`;
      if (chipsWrapper && chipsWrapper.parentElement === targetParent) {
        targetParent.insertBefore(masthead, chipsWrapper);
      } else {
        targetParent.prepend(masthead);
      }
      onDispose(() => masthead?.remove());
    }

    const eyebrow = masthead.querySelector(".tess-masthead-eyebrow");
    const greetingEl = masthead.querySelector(".tess-masthead-greeting");
    if (eyebrow) eyebrow.textContent = details.dateEyebrow;
    if (greetingEl) greetingEl.textContent = details.greeting;
  }

  function renderHero(heroData) {
    if (!heroData || !heroData.title) return;
    const mainContent = document.querySelector(".main-home-content");
    if (!mainContent) return;

    const shortcuts = mainContent.querySelector(".view-homeShortcutsGrid-shortcuts");
    let hero = document.getElementById("tess-home-hero");

    if (!hero || !hero.isConnected) {
      hero?.remove();
      hero = document.createElement("div");
      hero.id = "tess-home-hero";
      hero.setAttribute("role", "region");
      hero.setAttribute("aria-label", "Featured: " + heroData.title);

      hero.innerHTML = `
        <div class="tess-hero-ambient" aria-hidden="true"></div>
        <div class="tess-hero-inner">
          <div class="tess-hero-details">
            <div class="tess-hero-badge">
              <span class="tess-hero-badge-dot"></span>
              FEATURED
            </div>
            <h2 class="tess-hero-title"></h2>
            <p class="tess-hero-subtitle"></p>
            <div class="tess-hero-actions">
              <button class="tess-hero-btn tess-hero-btn-play">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l11-6.86a1 1 0 0 0 0-1.68l-11-6.86A1 1 0 0 0 8 5.14z"/>
                </svg>
                <span>Play</span>
              </button>
              <button class="tess-hero-btn tess-hero-btn-open">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
                <span>Open</span>
              </button>
            </div>
          </div>
          <div class="tess-hero-art-wrapper">
            <img class="tess-hero-art" alt="" loading="eager" />
          </div>
        </div>
      `;

      if (shortcuts && shortcuts.parentElement === mainContent) {
        mainContent.insertBefore(hero, shortcuts);
      } else {
        mainContent.prepend(hero);
      }
      onDispose(() => hero?.remove());
    }

    const ambient = hero.querySelector(".tess-hero-ambient");
    if (ambient && heroData.imgSrc) {
      ambient.style.backgroundImage = "url(\"" + heroData.imgSrc + "\")";
    }

    const titleEl = hero.querySelector(".tess-hero-title");
    if (titleEl) titleEl.textContent = heroData.title;

    const subEl = hero.querySelector(".tess-hero-subtitle");
    if (subEl) subEl.textContent = heroData.subtitle;

    const art = hero.querySelector(".tess-hero-art");
    if (art && heroData.imgSrc) {
      art.src = heroData.imgSrc;
      art.alt = heroData.title;
    }

    const playBtn = hero.querySelector(".tess-hero-btn-play");
    if (playBtn) {
      playBtn.setAttribute("aria-label", "Play " + heroData.title);
      playBtn.onclick = (e) => {
        e.stopPropagation();
        if (heroData.uri && Spicetify.Player?.playUri) {
          Spicetify.Player.playUri(heroData.uri);
        }
      };
    }

    const openBtn = hero.querySelector(".tess-hero-btn-open");
    if (openBtn) {
      openBtn.setAttribute("aria-label", "Open " + heroData.title);
      openBtn.onclick = (e) => {
        e.stopPropagation();
        if (heroData.link && Spicetify.Platform?.History?.push) {
          Spicetify.Platform.History.push(heroData.link);
        }
      };
    }

    hero.onclick = (e) => {
      if (e.target.closest("button")) return;
      if (heroData.link && Spicetify.Platform?.History?.push) {
        Spicetify.Platform.History.push(heroData.link);
      }
    };
  }

  function cleanHomeDOM() {
    document.documentElement.classList.remove("tess-home-active");
    document.getElementById("tess-home-masthead")?.remove();
    document.getElementById("tess-home-hero")?.remove();
  }

  let cachedFirstName = "Krish";
  getFirstName().then((name) => {
    cachedFirstName = name;
    if (isHome()) renderMasthead(cachedFirstName);
  });

  function syncHome() {
    if (!isHome()) {
      cleanHomeDOM();
      return;
    }
    document.documentElement.classList.add("tess-home-active");
    renderMasthead(cachedFirstName);
    const heroData = getHeroCardData();
    if (heroData) renderHero(heroData);
  }

  syncHome();

  if (Spicetify.Platform?.History?.listen) {
    const unlisten = Spicetify.Platform.History.listen(() => {
      syncHome();
      setTimeout(syncHome, 100);
      setTimeout(syncHome, 350);
    });
    onDispose(unlisten);
  }

  const scrollChild = document.querySelector(".main-view-container__scroll-node-child") || document.body;
  const observer = new MutationObserver(() => {
    if (isHome()) {
      if (!document.getElementById("tess-home-masthead") || !document.getElementById("tess-home-hero")) {
        syncHome();
      }
    }
  });

  observer.observe(scrollChild, { childList: true, subtree: true });
  onDispose(() => observer.disconnect());

  const interval = setInterval(() => {
    if (isHome()) syncHome();
  }, 1000);
  onDispose(() => clearInterval(interval));

  onDispose(() => cleanHomeDOM());

  console.log("[TessHome] Direction 1: Apple Music Listen Now mounted");
})();
