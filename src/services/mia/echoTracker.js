// Trackea los message IDs que Mia acaba de enviar, para distinguirlos del
// echo fromMe:true que Evolution reenvía al webhook. Si el id está aquí, es
// un mensaje de Mia (ignorar). Si NO está, es Mirai escribiendo manualmente
// desde su Business — eso lo guardamos como author='mirai' y activa el modo
// silencio para que Mia no interrumpa.
//
// TTL corto (10 min) porque los ecos suelen llegar en segundos.

const TTL_MS = 10 * 60 * 1000;
const seen = new Map(); // id -> expiresAt

export function rememberMiaSentId(id) {
  if (!id) return;
  seen.set(id, Date.now() + TTL_MS);
}

export function isMiaSentId(id) {
  if (!id) return false;
  const expires = seen.get(id);
  if (!expires) return false;
  if (expires < Date.now()) {
    seen.delete(id);
    return false;
  }
  return true;
}

// Limpieza periódica (no es crítica, solo evita crecer indefinido).
setInterval(() => {
  const now = Date.now();
  for (const [id, expires] of seen.entries()) {
    if (expires < now) seen.delete(id);
  }
}, 5 * 60 * 1000).unref?.();
