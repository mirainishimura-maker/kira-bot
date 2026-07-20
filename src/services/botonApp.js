// Versión "app web" del botón de cariño — para quien no quiere configurar
// Atajos/HTTP Shortcuts: GET /mirai/boton/app (o /piero/boton/app) sirve esta
// página con un botonzote 💙 que hace el POST por dentro (mismo token, por
// query). Se abre en el navegador del celular y se "Añade a pantalla de
// inicio": queda como un app. Autocontenida, sin assets externos.

export function botonAppHtml({ nombre, postPath, token }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#101f4d">
<title>&#128153;</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(160deg, #101f4d 0%, #1d2f6e 55%, #31418c 100%);
    color: #eef1ff;
    display: flex; align-items: center; justify-content: center;
    text-align: center; overflow: hidden;
  }
  main { padding: 24px; max-width: 340px; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; opacity: .75; }
  .sub { font-size: 14px; opacity: .6; margin-top: 6px; }
  #b {
    margin: 38px auto 30px; display: block;
    width: 200px; height: 200px; border-radius: 50%;
    border: none; cursor: pointer; font-size: 96px; line-height: 1;
    background: radial-gradient(circle at 32% 28%, #ffffff 0%, #dfe7ff 60%, #b9c8f8 100%);
    box-shadow: 0 18px 45px rgba(0,0,0,.45), inset 0 -6px 14px rgba(70,90,180,.35);
    transition: transform .12s ease;
    -webkit-tap-highlight-color: transparent;
  }
  #b:active { transform: scale(.9); }
  #b.enviando { animation: latido .5s ease infinite; }
  @keyframes latido { 0%,100% { transform: scale(1); } 50% { transform: scale(1.07); } }
  #m { min-height: 48px; font-size: 16px; line-height: 1.45; opacity: .92; white-space: pre-line; }
  .corazon {
    position: fixed; bottom: 18%; font-size: 26px; pointer-events: none;
    animation: subir 1.6s ease-out forwards;
  }
  @keyframes subir {
    from { transform: translateY(0) scale(1); opacity: 1; }
    to   { transform: translateY(-320px) scale(1.6); opacity: 0; }
  }
</style>
</head>
<body>
<main>
  <h1>Bot&oacute;n de cari&ntilde;o</h1>
  <p class="sub">un toque y ${nombre} lo siente</p>
  <button id="b" aria-label="Enviar un toque">&#128153;</button>
  <p id="m">Presiona cuando ${nombre} pase por tu mente.</p>
</main>
<script>
  var b = document.getElementById('b');
  var m = document.getElementById('m');
  var ocupado = false;

  function corazones() {
    for (var i = 0; i < 6; i++) {
      var c = document.createElement('span');
      c.className = 'corazon';
      c.textContent = '\\uD83D\\uDC99';
      c.style.left = (30 + Math.random() * 40) + '%';
      c.style.animationDelay = (Math.random() * 0.35) + 's';
      document.body.appendChild(c);
      setTimeout(function (el) { return function () { el.remove(); }; }(c), 2200);
    }
  }

  b.addEventListener('click', function () {
    if (ocupado) return;
    ocupado = true;
    b.classList.add('enviando');
    m.textContent = 'Enviando\\u2026';
    fetch('${postPath}?t=${token}', { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (x.j && x.j.mensaje) {
          m.textContent = x.j.mensaje;
          if (x.j.enviado) corazones();
        } else {
          m.textContent = x.r.ok ? 'Enviado \\uD83D\\uDC99' : 'Ups, intenta de nuevo en un toque \\uD83D\\uDE05';
        }
      })
      .catch(function () { m.textContent = 'Sin conexi\\u00f3n \\uD83D\\uDE05 intenta de nuevo'; })
      .then(function () {
        b.classList.remove('enviando');
        setTimeout(function () { ocupado = false; }, 900);
      });
  });
</script>
</body>
</html>`;
}
