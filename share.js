function getSharedGameId() {
  const raw = new URLSearchParams(location.search).get("game");
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const SHARED_GAME_ID = getSharedGameId();

function buildShareUrl(objectId) {
  return `${location.origin}${location.pathname}?game=${objectId}`;
}

function renderShareButton(objectId) {
  return `<button class="share-btn" type="button" data-share-id="${objectId}" title="Share this game" aria-label="Share this game">⤴</button>`;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initShareButtons(container) {
  if (!container) return;
  container.querySelectorAll(".share-btn").forEach((btn) => {
    if (btn.dataset.shareBound) return;
    btn.dataset.shareBound = "1";
    btn.addEventListener("click", () => handleShareClick(btn));
  });
}

async function handleShareClick(btn) {
  const card = btn.closest("article.game-card") || btn.closest(".game-card");
  if (!card) return;

  const objectId = Number(btn.dataset.shareId);
  const originalLabel = btn.textContent;

  const restoreLabelAfter = (label, delay) => {
    setTimeout(() => {
      btn.textContent = originalLabel;
    }, delay);
    btn.textContent = label;
  };

  btn.style.visibility = "hidden";
  try {
    const canvas = await html2canvas(card, {
      scale: 2,
      useCORS: true,
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    });

    const title = card.querySelector("h2, h3")?.textContent?.trim() || "Board game";
    const shareUrl = buildShareUrl(objectId);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

    const file = new File([blob], "game.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title, url: shareUrl });
      } catch {
        // User cancelled the share sheet — nothing to do.
      }
    } else {
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${slugify(title)}-${objectId}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      }

      restoreLabelAfter("✓", 1500);
    }
  } catch (error) {
    console.error(error);
    restoreLabelAfter("✕", 1500);
  } finally {
    btn.style.visibility = "visible";
  }
}
