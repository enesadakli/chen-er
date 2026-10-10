// Copy buttons and the optional demo recording. The page works without this file.
(function () {
  "use strict";

  var status = document.getElementById("copy-status");

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (error) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve(); else reject(new Error("copy failed"));
    });
  }

  document.querySelectorAll("button[data-copy]").forEach(function (button) {
    var source = document.getElementById(button.getAttribute("data-copy"));
    var label = button.querySelector(".copy-label");
    if (!source || !label) return;
    button.hidden = false;
    button.setAttribute("aria-label", "Copy the install command");
    var timer = 0;
    button.addEventListener("click", function () {
      copyText(source.textContent.trim()).then(function () {
        label.textContent = "Copied";
        button.classList.remove("done");
        void button.offsetWidth;
        button.classList.add("done");
        if (status) status.textContent = "Install command copied to the clipboard.";
      }, function () {
        label.textContent = "Select and copy";
        if (status) status.textContent = "Copying failed. Select the command and copy it manually.";
        var range = document.createRange();
        range.selectNodeContents(source);
        var selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      });
      clearTimeout(timer);
      timer = setTimeout(function () { label.textContent = "Copy"; button.classList.remove("done"); }, 2400);
    });
  });

  // The recording replaces the rendered poster only when assets/demo.gif exists.
  var media = document.getElementById("demo-media");
  var caption = document.querySelector("#demo-caption span");
  var play = document.getElementById("demo-play");
  if (!media) return;
  var demo = media.getAttribute("data-demo");
  if (!demo) return;
  var probe = new Image();
  probe.onload = function () {
    var show = function () {
      media.src = demo;
      var link = document.getElementById("demo-link");
      if (link) link.setAttribute("href", demo);
      media.removeAttribute("width");
      media.removeAttribute("height");
      media.alt = "Screen recording of the chen serve viewer: a YAML model is changed and the Chen diagram updates beside the notes column.";
      if (caption) caption.textContent = "Recording of the chen serve viewer.";
      if (play) play.hidden = true;
    };
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce && play) {
      play.hidden = false;
      play.addEventListener("click", show);
    } else {
      show();
    }
  };
  probe.src = demo;
})();
