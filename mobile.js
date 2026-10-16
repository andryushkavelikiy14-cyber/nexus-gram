// ============ START ============
// Если открыто НЕ с мобильного и не через /mobile — редирект на ПК-версию
const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Mobile/i.test(navigator.userAgent);

// Если открыли /mobile с ПК — можно оставить, ничего страшного
// Но если открыли корень с телефона — можно перекинуть на /mobile (опционально)

if (loadSession()) enterApp();