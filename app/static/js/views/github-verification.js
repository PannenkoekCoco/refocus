import { renderNarrator } from "../components/narrator.js";

const READ_ONLY_PERMISSIONS = [
  "Metadata — read",
  "Contents — read",
  "Pull requests — read",
  "Checks — read",
  "Commit statuses — read",
];

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function repositoriesFor(connection) {
  if (!connection?.connected || !Array.isArray(connection.installations)) return [];
  return connection.installations.flatMap((installation) => (
    Array.isArray(installation.repositories)
      ? installation.repositories.map((repository) => ({ installation, repository }))
      : []
  ));
}

function selectedRepository(connection) {
  return repositoriesFor(connection).find(({ repository }) => repository.selected)?.repository ?? null;
}

function connectionNarration(connection, selected) {
  if (!connection?.connected) {
    return "GitHub verification is optional. Refocus asks only for read access to metadata, contents, pull requests, checks, and commit statuses. It has no webhooks or write access.";
  }
  if (!selected) {
    return "GitHub is connected. Choose one repository returned by GitHub before verifying this mission.";
  }
  return `GitHub is connected to ${selected.fullName}. You can verify the authored evidence for this mission with read-only access.`;
}

function resultNarration(result) {
  const evidence = result.evidence.length > 0 ? ` Evidence: ${result.evidence.join(". ")}.` : "";
  const reason = result.reason ? ` ${result.reason}` : "";
  return `GitHub verification ${result.status === "verified" ? "verified" : "needs attention"}.${evidence}${reason}`;
}

function messageForConnectionStart(result) {
  if (result?.reason === "not_configured") {
    return "GitHub connection is not configured yet. You can keep using the self-review checklist.";
  }
  return "GitHub connection could not be started right now. You can keep using the self-review checklist.";
}

function renderVerificationResult({ container, result, tts, onNarrationError }) {
  container.replaceChildren();
  const heading = createElement(
    "h4",
    result.status === "verified" ? "Verified" : "Needs attention",
  );
  const evidence = createElement("ul");
  evidence.className = "github-verification-evidence";
  for (const item of result.evidence) {
    evidence.append(createElement("li", item));
  }
  const reason = result.reason ? createElement("p", result.reason) : null;
  const narrator = createElement("div");
  narrator.className = "narrator";
  renderNarrator({
    container: narrator,
    speechText: resultNarration(result),
    tts,
    onError: onNarrationError,
  });

  container.append(heading);
  if (result.evidence.length > 0) container.append(evidence);
  if (reason) container.append(reason);
  container.append(narrator);
}

export function renderGitHubVerification({
  container,
  mission,
  connection,
  tts,
  onNarrationError,
  onConnect,
  onSelectRepository,
  onVerify,
  onDisconnect,
  onStatus = () => {},
}) {
  const panel = createElement("section");
  panel.className = "github-verification";
  panel.setAttribute("aria-labelledby", "github-verification-heading");

  const heading = createElement("h3", "Optional GitHub verification");
  heading.id = "github-verification-heading";
  const introduction = createElement(
    "p",
    "Connect a GitHub App only when you want Refocus to check the authored mission evidence. Your self-review remains available without GitHub.",
  );
  const narrator = createElement("div");
  narrator.className = "narrator";
  const selected = selectedRepository(connection);
  renderNarrator({
    container: narrator,
    speechText: connectionNarration(connection, selected),
    tts,
    onError: onNarrationError,
  });

  const permissionsHeading = createElement("h4", "Read-only permissions");
  const permissions = createElement("ul");
  permissions.className = "github-permissions";
  for (const permission of READ_ONLY_PERMISSIONS) {
    permissions.append(createElement("li", permission));
  }
  permissions.append(createElement("li", "Only selected repositories"));
  permissions.append(createElement("li", "No webhooks or write access"));

  const feedback = createElement("div");
  feedback.className = "github-verification-feedback";
  feedback.setAttribute("aria-live", "polite");

  panel.append(heading, introduction, narrator, permissionsHeading, permissions);

  if (!connection?.connected) {
    const status = createElement(
      "p",
      "GitHub is not connected. Connect it only if you want to verify this mission from an authorized repository.",
    );
    const connect = createElement("button", "Connect GitHub");
    connect.type = "button";
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      try {
        const result = await onConnect();
        if (!result?.started) {
          const message = messageForConnectionStart(result);
          feedback.replaceChildren(createElement("p", message));
          onStatus(message);
          connect.disabled = false;
        }
      } catch {
        const message = messageForConnectionStart(null);
        feedback.replaceChildren(createElement("p", message));
        onStatus(message);
        connect.disabled = false;
      }
    });
    panel.append(status, connect, feedback);
    container.append(panel);
    return;
  }

  const repositoryChoices = repositoriesFor(connection);
  if (repositoryChoices.length === 0) {
    panel.append(createElement("p", "GitHub is connected, but no selected repositories are available to verify yet."));
  } else {
    const repositoryLabel = createElement("label", "GitHub repository");
    repositoryLabel.htmlFor = "github-repository";
    const repositorySelect = createElement("select");
    repositorySelect.id = "github-repository";
    repositorySelect.name = "github-repository";
    const placeholder = createElement("option", "Choose a repository");
    placeholder.value = "";
    placeholder.disabled = true;
    repositorySelect.append(placeholder);
    for (const { installation, repository } of repositoryChoices) {
      const option = createElement(
        "option",
        `${repository.fullName} (${installation.accountLogin})`,
      );
      option.value = String(repository.id);
      option.selected = repository.selected;
      repositorySelect.append(option);
    }
    repositorySelect.value = selected ? String(selected.id) : "";
    repositorySelect.addEventListener("change", async () => {
      const repositoryId = Number(repositorySelect.value);
      if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return;
      repositorySelect.disabled = true;
      try {
        const repository = await onSelectRepository(repositoryId);
        if (!repository) {
          const message = "That repository could not be selected. Choose an authorized repository and try again.";
          feedback.replaceChildren(createElement("p", message));
          onStatus(message);
          repositorySelect.disabled = false;
        }
      } catch {
        const message = "That repository could not be selected. Choose an authorized repository and try again.";
        feedback.replaceChildren(createElement("p", message));
        onStatus(message);
        repositorySelect.disabled = false;
      }
    });
    panel.append(repositoryLabel, repositorySelect);

    if (mission.evidence?.requireDeploymentUrl) {
      const deploymentLabel = createElement("label", "Deployment URL");
      deploymentLabel.htmlFor = "mission-deployment-url";
      const deploymentUrl = createElement("input");
      deploymentUrl.id = "mission-deployment-url";
      deploymentUrl.name = "mission-deployment-url";
      deploymentUrl.type = "url";
      deploymentUrl.maxLength = 2_048;
      deploymentUrl.autocomplete = "url";
      panel.append(deploymentLabel, deploymentUrl);
      panel.dataset.deploymentInputId = deploymentUrl.id;
    }

    const verify = createElement("button", "Verify with GitHub");
    verify.type = "button";
    verify.disabled = selected === null;
    verify.addEventListener("click", async () => {
      verify.disabled = true;
      const deploymentInput = panel.querySelector("#mission-deployment-url");
      const deploymentUrl = deploymentInput instanceof HTMLInputElement
        ? deploymentInput.value.trim()
        : undefined;
      try {
        const result = await onVerify(mission.id, { deploymentUrl });
        if (result) {
          renderVerificationResult({
            container: feedback,
            result,
            tts,
            onNarrationError,
          });
        } else {
          const message = "GitHub evidence could not be checked right now. You can keep using the self-review checklist.";
          feedback.replaceChildren(createElement("p", message));
          onStatus(message);
        }
      } catch {
        const message = "GitHub evidence could not be checked right now. You can keep using the self-review checklist.";
        feedback.replaceChildren(createElement("p", message));
        onStatus(message);
      } finally {
        verify.disabled = selected === null;
      }
    });
    panel.append(verify);
  }

  const disconnect = createElement("button", "Disconnect GitHub");
  disconnect.type = "button";
  disconnect.className = "secondary";
  disconnect.addEventListener("click", async () => {
    disconnect.disabled = true;
    try {
      const disconnected = await onDisconnect();
      if (!disconnected) {
        const message = "GitHub could not be disconnected right now. Your current connection remains unchanged.";
        feedback.replaceChildren(createElement("p", message));
        onStatus(message);
        disconnect.disabled = false;
      }
    } catch {
      const message = "GitHub could not be disconnected right now. Your current connection remains unchanged.";
      feedback.replaceChildren(createElement("p", message));
      onStatus(message);
      disconnect.disabled = false;
    }
  });
  panel.append(disconnect, feedback);
  container.append(panel);
}
