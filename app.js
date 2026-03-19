import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  getDoc,
  getDocs,
  setDoc,
  doc,
  updateDoc,
  deleteDoc,
  writeBatch,
  onSnapshot,
  runTransaction,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  reauthenticateWithCredential,
  updatePassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import { SEED_ITEMS } from "./data.js";

// --- Configuração ---
const firebaseConfig = {
  apiKey: "AIzaSyDCu2wlBkSbD7wLvTmoZdz1ICjg5rpCzsM",
  authDomain: "gestao-de-estoque-20615.firebaseapp.com",
  projectId: "gestao-de-estoque-20615",
  storageBucket: "gestao-de-estoque-20615.firebasestorage.app",
  messagingSenderId: "925516712156",
  appId: "1:925516712156:web:4c8fa2f49982c03fca8c19",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- Serviços (Firestore) ---
const FirestoreService = {
  profile: null,
  users: [],
  items: [],
  deposits: [],
  movements: [],
  previousItemsMap: new Map(),
  _authUnsub: null,
  _listenersStarted: false,
  _itemsUnsub: null,
  _depositsUnsub: null,
  _movementsUnsub: null,

  async init() {
    try {
      try {
        await setPersistence(auth, browserLocalPersistence);
      } catch {}

      const bootTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("BOOT_TIMEOUT")), 6500),
      );

      let resolved = false;

      if (!this._authUnsub) {
        this._authUnsub = onAuthStateChanged(auth, async (fbUser) => {
          try {
            if (fbUser) {
              await this.ensureUserProfile(fbUser);
              if (!this._listenersStarted) {
                this._listenersStarted = true;
                this.setupRealtimeListener(() => {});
              }
              if (window.App && typeof window.App.initLayout === "function") {
                window.App.initLayout();
              }
            } else {
              this.profile = null;
              this.items = [];
              this.deposits = [];
              this._listenersStarted = false;
              try {
                this._itemsUnsub?.();
              } catch {}
              this._itemsUnsub = null;
              try {
                this._depositsUnsub?.();
              } catch {}
              this._depositsUnsub = null;
              try {
                this._movementsUnsub?.();
              } catch {}
              this._movementsUnsub = null;
              const appLayout = document.getElementById("app-layout");
              if (appLayout) appLayout.classList.add("hidden");
              const loginLayout = document.getElementById("login-layout");
              if (loginLayout) {
                loginLayout.classList.add("hidden");
                loginLayout.classList.remove("flex");
              }
              const landingLayout = document.getElementById("landing-layout");
              if (landingLayout) landingLayout.classList.remove("hidden");
            }
          } catch (err) {
            console.error("Falha no handler de auth:", err);
          } finally {
            if (!resolved) {
              resolved = true;
              this._bootResolve?.();
            }
          }
        });
      }

      await Promise.race([
        new Promise((resolve) => {
          this._bootResolve = resolve;
          if (resolved) resolve();
        }),
        bootTimeout,
      ]);
    } catch (e) {
      console.error("Erro ao conectar Firebase:", e);
      const loadingText = document.getElementById("loading-text");
      if (loadingText) {
        loadingText.textContent =
          "Não foi possível conectar ao Firebase. Verifique domínios autorizados, Auth e conexão.";
      }
      try {
        ToastManager?.show?.(
          "Falha ao conectar ao Firebase. Verifique domínios autorizados e conexão.",
          "error",
        );
      } catch {}
    }
  },

  async ensureUserProfile(fbUser) {
    const user = fbUser || auth.currentUser;
    if (!user) throw new Error("NO_AUTH_USER");

    const PRESET_BY_EMAIL = {
      "antoniosousa.junior@camara.leg.br": {
        name: "Antônio",
        role: "user",
        label: "Usuário",
      },
      "jesse.anjos@camara.leg.br": {
        name: "Jessé",
        role: "user",
        label: "Usuário",
      },
      "jefferson.araujo@camara.leg.br": {
        name: "Jefferson",
        role: "admin",
        label: "Administrador",
      },
    };

    const uid = user.uid;
    const ref = doc(db, "users", uid);

    const safeName =
      user.displayName || (user.email ? user.email.split("@")[0] : "Usuário");
    const emailKey = (user.email || "").toLowerCase();
    const preset = PRESET_BY_EMAIL[emailKey] || null;
    const desiredName = preset?.name || safeName;
    const desiredRole = preset?.role || "user";
    const desiredLabel =
      preset?.label || (desiredRole === "admin" ? "Administrador" : "Usuário");

    this.profile = this.profile || {
      uid,
      name: desiredName,
      label: desiredLabel,
      role: desiredRole,
      active: true,
      email: user.email || null,
      tenantName: "COENG | DETEC", // Padrão SaaS fallback
    };
    this.isNewUser = false;

    const snap = await getDoc(ref);
    if (!snap.exists()) {
      this.isNewUser = true; // Flag para disparar o Onboarding Automático
      const baseDoc = {
        uid,
        email: user.email || null,
        name: desiredName,
        role: desiredRole,
        label: desiredLabel,
        active: true,
        tenantName: "Nova Empresa",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      try {
        await setDoc(ref, baseDoc, { merge: true });
      } catch (writeErr) {
        if (desiredRole === "admin") {
          try {
            await setDoc(
              ref,
              {
                ...baseDoc,
                role: "user",
                label: "Usuário",
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            );
            ToastManager?.show?.(
              "Perfil criado como Usuário. Para tornar Administrador, defina role=admin em users/{uid} ou via Claims.",
              "warning",
            );
          } catch (writeErr2) {
            console.warn("Falha ao criar perfil fallback:", writeErr2);
            throw writeErr2;
          }
        } else {
          throw writeErr;
        }
      }
    } else {
      const data = snap.data() || {};
      const patch = {};
      if (!data.uid) patch.uid = uid;
      if (!data.email && user.email) patch.email = user.email;
      if (!data.name) patch.name = desiredName;
      if (!data.role && desiredRole) patch.role = desiredRole;
      patch.lastLoginAt = serverTimestamp(); // Controle de Sessão
      if (!data.tenantName) patch.tenantName = "COENG | DETEC";
      if (!data.label) {
        const r = data.role || patch.role || "user";
        patch.label = r === "admin" ? "Administrador" : "Usuário";
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = serverTimestamp();
        try {
          await setDoc(ref, patch, { merge: true });
        } catch (patchErr) {
          if ("role" in patch) {
            const safePatch = { ...patch };
            delete safePatch.role;
            safePatch.label =
              (data.role || "user") === "admin" ? "Administrador" : "Usuário";
            await setDoc(ref, safePatch, { merge: true });
          } else {
            throw patchErr;
          }
        }
      }
    }

    onSnapshot(
      ref,
      (d) => {
        const data = d.exists() ? d.data() : null;
        this.profile = data || this.profile;
        if (window.App && typeof window.App.updateUserProfile === "function") {
          window.App.updateUserProfile();
        }
      },
      (err) => {
        console.warn("Listener users/{uid} falhou:", err);
      },
    );
  },

  setupRealtimeListener(onFirstLoad) {
    this.setupDepositsListener();
    this.setupMovementsListener();
    const itemsRef = collection(db, "items");
    try {
      this._itemsUnsub?.();
    } catch {}

    this._itemsUnsub = onSnapshot(itemsRef, async (snapshot) => {
      if (snapshot.empty) {
        document.getElementById("loading-text").innerText =
          "Criando banco de dados...";
        let localItems = null;
        try {
          localItems = JSON.parse(localStorage.getItem("serob_db_items"));
        } catch (e) {
          console.warn("Falha ao ler backup do LocalStorage", e);
        }
        const itemsToUpload = localItems || SEED_ITEMS;
        const batch = writeBatch(db);
        itemsToUpload.forEach((item) => {
          const docRef = doc(db, "items", String(item.id));
          batch.set(docRef, item);
        });
        await batch.commit();
      } else {
        const rawItems = snapshot.docs.map((d) => d.data());

        // Motor de Notificações em Tempo Real
        if (this.items.length > 0) {
          let alertsCount = 0;
          rawItems.forEach((newItem) => {
            const oldItem = this.previousItemsMap.get(newItem.id);
            if (oldItem) {
              const currEstoque = Number(newItem.estoque) || 0;
              const oldEstoque = Number(oldItem.estoque) || 0;
              const minEstoque = Number(newItem.estoqueMinimo) || 0;

              // Dispara notificação se esgotou ou ficou crítico neste exato momento
              if (currEstoque <= 0 && oldEstoque > 0 && alertsCount < 3) {
                ToastManager.show(
                  `🚨 ATENÇÃO: O item "${newItem.descricao}" acabou de esgotar no estoque!`,
                  "error",
                );
                alertsCount++;
              } else if (
                currEstoque <= minEstoque &&
                oldEstoque > minEstoque &&
                alertsCount < 3
              ) {
                ToastManager.show(
                  `⚠️ ALERTA REAL-TIME: "${newItem.descricao}" atingiu nível crítico (${currEstoque} un).`,
                  "warning",
                );
                alertsCount++;
              }
            }
            this.previousItemsMap.set(newItem.id, newItem);
          });
        } else {
          rawItems.forEach((i) => this.previousItemsMap.set(i.id, i));
        }

        this.items = rawItems.sort((a, b) => {
          const catA = (a.categoria || "").toString();
          const catB = (b.categoria || "").toString();
          const diffCat = catA.localeCompare(catB, "pt-BR", {
            numeric: true,
            sensitivity: "base",
          });
          if (diffCat !== 0) return diffCat;
          const descA = (a.descricao || "").toString();
          const descB = (b.descricao || "").toString();
          return descA.localeCompare(descB, "pt-BR", {
            numeric: true,
            sensitivity: "base",
          });
        });

        this.checkAndMigrateItems();

        if (window.App && typeof window.App.refreshUI === "function") {
          window.App.refreshUI();
        }

        if (onFirstLoad) {
          onFirstLoad();
          onFirstLoad = null;
        }
      }
    });
  },

  setupDepositsListener() {
    try {
      this._depositsUnsub?.();
    } catch {}
    const depositsRef = collection(db, "deposits");
    this._depositsUnsub = onSnapshot(
      depositsRef,
      (snapshot) => {
        const list = snapshot.docs.map((d) => {
          const data = d.data() || {};
          return {
            id: d.id,
            name: (data.name || data.nome || "").toString(),
            order: Number(data.order ?? data.ordem ?? 999999),
          };
        });

        list.sort((a, b) => {
          const diff = (a.order || 0) - (b.order || 0);
          if (diff !== 0) return diff;
          return (a.name || "").localeCompare(b.name || "", "pt-BR", {
            numeric: true,
            sensitivity: "base",
          });
        });

        this.deposits = list.filter(
          (d) =>
            (d.name || "").toString().trim().toUpperCase() !== "DEPÓSITO GERAL",
        );

        if (
          window.App &&
          typeof window.App.renderDepositOptions === "function"
        ) {
          window.App.renderDepositOptions();
        }

        try {
          window.InventoryController?.handleCodigoInternoAutoFill?.();
        } catch {}
      },
      (err) => {
        console.warn("Listener deposits falhou:", err);
      },
    );
  },

  setupMovementsListener() {
    try {
      this._movementsUnsub?.();
    } catch {}
    const q = query(
      collection(db, "movements"),
      orderBy("date", "desc"),
      limit(200),
    );
    this._movementsUnsub = onSnapshot(
      q,
      (snapshot) => {
        this.movements = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        if (window.App && window.App.currentTab === "movement-search") {
          if (typeof window.App.renderHistoryTableRows === "function") {
            window.App.renderHistoryTableRows();
          }
        }
      },
      (err) => console.warn("Listener movements falhou:", err),
    );
  },

  checkAndMigrateItems() {
    const batch = writeBatch(db);
    let hasUpdates = false;
    const seedMap = new Map(SEED_ITEMS.map((s) => [s.id, s]));

    this.items.forEach((item) => {
      const seed = seedMap.get(item.id);
      if (seed) {
        let updated = false;
        const fields = [
          "qtdRessuprimento",
          "estoqueMinimo",
          "custoMedio",
          "unidadeEntrada",
          "conversao",
          "situacao",
          "estoqueReuso",
        ];
        const updates = {};
        fields.forEach((field) => {
          if (item[field] === undefined) {
            updates[field] = seed[field];
            updated = true;
          }
        });
        if (updated) {
          const docRef = doc(db, "items", String(item.id));
          batch.update(docRef, updates);
          hasUpdates = true;
        }
      }
    });
    if (hasUpdates) batch.commit();
  },

  async updateStock(id, qty, type, reason = "") {
    const itemIndex = this.items.findIndex((i) => i.id === id);
    if (itemIndex === -1) return false;
    const item = this.items[itemIndex];
    let newStock = item.estoque;
    if (type === "entrada") newStock += qty;
    else newStock = Math.max(0, newStock - qty);
    try {
      const batch = writeBatch(db);
      const itemRef = doc(db, "items", String(id));
      batch.update(itemRef, { estoque: newStock });

      const user = AuthService.getCurrentUser();
      const movRef = doc(collection(db, "movements"));
      batch.set(movRef, {
        itemId: id,
        itemCodigo: item.codigo || "",
        itemCodigoInterno: item.codigoInterno || "",
        itemDesc: item.descricao || "",
        type: type,
        qty: qty,
        reason: reason,
        previousStock: item.estoque,
        newStock: newStock,
        userName: user ? user.name : "Desconhecido",
        userEmail: user ? user.email : "",
        date: serverTimestamp(),
      });

      await batch.commit();
      return true;
    } catch (e) {
      console.error("Erro ao salvar no Firebase:", e);
      return false;
    }
  },

  async updateUserPassword(username, newHash) {
    try {
      const userRef = doc(db, "users", username);
      await updateDoc(userRef, { passwordHash: newHash });
      const userIndex = this.users.findIndex((u) => u.username === username);
      if (userIndex > -1) this.users[userIndex].passwordHash = newHash;
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  },

  async importItems(newItems) {
    if (!AuthService.isAdmin()) {
      throw new Error("permission-denied");
    }
    for (let i = 0; i < newItems.length; i += 500) {
      const chunk = newItems.slice(i, i + 500);
      const batch = writeBatch(db);
      chunk.forEach((item) => {
        const docRef = doc(db, "items", String(item.id));
        batch.set(docRef, item);
      });
      await batch.commit();
    }
    this.items = [...this.items, ...newItems];
    return true;
  },

  async addItem(newItem) {
    if (!AuthService.isAdmin()) {
      throw new Error("permission-denied");
    }
    try {
      const newId = Date.now();
      const itemWithId = { ...newItem, id: newId };
      const docRef = doc(db, "items", String(newId));
      await setDoc(docRef, itemWithId);
      return true;
    } catch (e) {
      console.error("Erro ao adicionar item:", e);
      return false;
    }
  },

  async resetData() {
    if (!AuthService.isAdmin()) {
      throw new Error("permission-denied");
    }
    for (let i = 0; i < this.items.length; i += 500) {
      const chunk = this.items.slice(i, i + 500);
      const batch = writeBatch(db);
      chunk.forEach((item) => {
        const docRef = doc(db, "items", String(item.id));
        batch.delete(docRef);
      });
      await batch.commit();
    }
    localStorage.removeItem("serob_db_items");
    location.reload();
  },
};

const SecurityUtils = {
  async hash(string) {
    const utf8 = new TextEncoder().encode(string);
    const hashBuffer = await crypto.subtle.digest("SHA-256", utf8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  },
};

const Utils = {
  escapeHTML(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },
  debounce(func, wait = 300) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },
  formatCurrency(value) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value || 0);
  },
};

const AuthService = {
  state: { currentUser: null },
  restoreSession() {
    this.state.currentUser = null;
  },
  getCurrentUser() {
    return FirestoreService.profile || this.state.currentUser;
  },
  isAdmin() {
    const u = this.getCurrentUser();
    return !!(u && u.role === "admin");
  },
  async login(email, password, remember = true) {
    const em = (email || "").trim().toLowerCase();
    if (!em || !password) return false;

    try {
      await setPersistence(
        auth,
        remember ? browserLocalPersistence : browserSessionPersistence,
      );
    } catch {}

    // Removido o try/catch interno para que o AuthController possa ler o código do erro
    await signInWithEmailAndPassword(auth, em, password);
    return true;
  },
  async resetPassword(email) {
    const em = (email || "").trim().toLowerCase();
    if (!em) throw new Error("EMAIL_REQUIRED");
    await sendPasswordResetEmail(auth, em);
    return true;
  },
  async changePassword(currentPassword, newPassword) {
    const fbUser = auth.currentUser;
    if (!fbUser || !fbUser.email) throw new Error("NO_AUTH_USER");
    const cred = EmailAuthProvider.credential(fbUser.email, currentPassword);
    await reauthenticateWithCredential(fbUser, cred);
    await updatePassword(fbUser, newPassword);
    return true;
  },
  async logout() {
    this.state.currentUser = null;
    localStorage.removeItem("serob_session");
    try {
      await signOut(auth);
    } catch {}
  },
  async seedDefaultUsers() {
    const defaultPassword = prompt(
      "Defina a senha inicial para os novos usuários (mínimo 6 caracteres):",
    );
    if (!defaultPassword || defaultPassword.length < 6) {
      ToastManager.show(
        "Operação cancelada. Senha inválida ou muito curta.",
        "warning",
      );
      return;
    }

    const secondaryApp = initializeApp(firebaseConfig, "SecondaryAuthApp");
    const secondaryAuth = getAuth(secondaryApp);

    const defaultUsers = [
      {
        email: "jesse.anjos@camara.leg.br",
        password: defaultPassword,
        name: "Jessé",
      },
      {
        email: "antoniosousa.junior@camara.leg.br",
        password: defaultPassword,
        name: "Antônio",
      },
    ];

    let created = 0;
    for (const u of defaultUsers) {
      try {
        const userCred = await createUserWithEmailAndPassword(
          secondaryAuth,
          u.email,
          u.password,
        );
        const newUid = userCred.user.uid;

        await setDoc(doc(db, "users", newUid), {
          uid: newUid,
          email: u.email,
          name: u.name,
          role: "user",
          label: "Usuário",
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await signOut(secondaryAuth);
        created++;
        console.log(
          `Usuário ${u.name} registrado no Auth e no Banco de Dados.`,
        );
      } catch (error) {
        console.warn(`Aviso ao registrar ${u.email}:`, error.message);
      }
    }

    if (created > 0) {
      ToastManager.show(
        `${created} usuários criados com sucesso com a senha informada!`,
        "success",
      );
    } else {
      ToastManager.show(
        "Os usuários já existem no Firebase ou ocorreu um erro.",
        "warning",
      );
    }
  },
};

window.AuthService = AuthService;

const ToastManager = {
  container: document.getElementById("toast-container"),
  show(message, type = "success") {
    const toast = document.createElement("div");
    const colors =
      type === "success"
        ? "bg-emerald-500"
        : type === "warning"
          ? "bg-amber-500"
          : type === "entrada"
            ? "bg-emerald-500"
            : "bg-red-500";
    const icon =
      type === "success"
        ? "check-circle"
        : type === "warning"
          ? "alert-triangle"
          : type === "entrada"
            ? "arrow-down-to-line"
            : "alert-circle";
    toast.className = `toast flex items-center gap-3 px-4 py-3 rounded-xl text-white ${colors} animate-scale-in`;
    toast.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5"></i><span class="font-medium text-sm">${message}</span>`;
    this.container.appendChild(toast);
    lucide.createIcons();
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-10px)";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};

const ModalManager = {
  open(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    requestAnimationFrame(() => {
      modal.classList.remove("opacity-0", "pointer-events-none");
      modal.querySelector('div[id$="-content"]')?.classList.remove("scale-95");
      modal.querySelector('div[id$="-content"]')?.classList.add("scale-100");
    });
  },
  close(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("opacity-0", "pointer-events-none");
    modal.querySelector('div[id$="-content"]')?.classList.remove("scale-100");
    modal.querySelector('div[id$="-content"]')?.classList.add("scale-95");
    setTimeout(() => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }, 300);
  },
};

const AuthController = {
  async handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById("login-username").value;
    const pass = document.getElementById("login-password").value;
    const remember = !!document.getElementById("login-remember")?.checked;
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i>`;
    lucide.createIcons();
    btn.disabled = true;
    try {
      await AuthService.login(email, pass, remember);
      const errEl = document.getElementById("login-error");
      errEl?.classList.add("hidden");
      App.initLayout();
    } catch (err) {
      console.error(err);
      const errEl = document.getElementById("login-error");
      let msg = "Erro ao fazer login. Verifique sua conexão.";

      if (
        err.code === "auth/invalid-credential" ||
        err.code === "auth/user-not-found" ||
        err.code === "auth/wrong-password"
      ) {
        msg = "Usuário ou senha incorretos.";
      } else if (err.code === "auth/too-many-requests") {
        msg = "Muitas tentativas falhas. Tente novamente mais tarde.";
      }

      if (errEl) {
        errEl.querySelector("span").textContent = msg;
        errEl.classList.remove("hidden");
        setTimeout(() => errEl.classList.add("hidden"), 4000);
      }
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
      lucide.createIcons();
    }
  },
  async changePassword(e) {
    e.preventDefault();
    const current = document.getElementById("pwd-current").value;
    const newPwd = document.getElementById("pwd-new").value;
    const confirm = document.getElementById("pwd-confirm").value;

    if (!current || !newPwd) {
      ToastManager.show("Preencha todos os campos.", "error");
      return;
    }
    if (newPwd.length < 6) {
      ToastManager.show(
        "A nova senha deve ter pelo menos 6 caracteres.",
        "error",
      );
      return;
    }
    if (newPwd !== confirm) {
      ToastManager.show("Confirmação não coincide.", "error");
      return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = "Salvando...";
    btn.disabled = true;
    try {
      await AuthService.changePassword(current, newPwd);
      ToastManager.show("Senha alterada com sucesso!");
      ModalManager.close("modal-password");
      e.target.reset();
    } catch (err) {
      console.warn(err);
      ToastManager.show(
        "Não foi possível alterar a senha. Verifique a senha atual e tente novamente.",
        "error",
      );
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
  },

  async handleForgotPassword() {
    const email = document.getElementById("login-username")?.value || "";
    const em = (email || "").trim().toLowerCase();
    if (!em) {
      ToastManager.show("Digite seu email para redefinir a senha.", "error");
      return;
    }
    try {
      await AuthService.resetPassword(em);
      ToastManager.show(
        "Email de redefinição enviado. Verifique sua caixa de entrada.",
        "success",
      );
    } catch (err) {
      console.warn(err);
      ToastManager.show(
        "Não foi possível enviar o email de redefinição. Verifique o email e tente novamente.",
        "error",
      );
    }
  },
};

const InventoryController = {
  state: {
    activeModalItem: null,
    activeModalType: "entrada",
    searchTerm: "",
    searchName: "",
    searchCode: "",
    categoryFilter: "Todas",
    statusFilter: "Todos",
    currentExportData: null,
    currentPage: 1,
    itemsPerPage: 50,
  },
  openMovementModal(itemId, type = "entrada") {
    const item = FirestoreService.items.find(
      (i) => String(i.id) === String(itemId),
    );
    if (!item) {
      console.error("Item não encontrado para o ID:", itemId);
      return;
    }
    this.state.activeModalItem = item;
    this.state.activeModalType = type;
    document.getElementById("modal-mov-title").innerText =
      type === "entrada" ? "Registrar Entrada" : "Registrar Saída";
    document.getElementById("modal-mov-item").innerText = item.descricao;
    document.getElementById("modal-mov-current").innerText = item.estoque;
    const btn = document.getElementById("modal-mov-confirm");
    btn.className = `flex-1 px-4 py-3 rounded-xl font-bold text-white shadow-lg transition-all transform active:scale-95 ${type === "entrada" ? "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20" : "bg-red-600 hover:bg-red-700 shadow-red-600/20"}`;
    const reasonEl = document.getElementById("modal-mov-reason");
    if (reasonEl) reasonEl.value = "";

    const qtyInput = document.getElementById("modal-mov-qty");
    if (type === "saida") {
      qtyInput.max = item.estoque;
      if (item.estoque <= 0) {
        qtyInput.value = 0;
        btn.disabled = true;
      } else {
        qtyInput.value = 1;
        btn.disabled = false;
      }
    } else {
      qtyInput.removeAttribute("max");
      qtyInput.value = 1;
      btn.disabled = false;
    }

    this.calculateNewStock();
    ModalManager.open("modal-movement");
  },
  calculateNewStock() {
    let qty = parseInt(document.getElementById("modal-mov-qty").value) || 0;
    if (!this.state.activeModalItem) return;
    const current = this.state.activeModalItem.estoque;

    if (this.state.activeModalType === "saida" && qty > current) {
      qty = current;
      document.getElementById("modal-mov-qty").value = qty;
    }

    let newVal = 0;
    const el = document.getElementById("modal-mov-new");
    if (this.state.activeModalType === "entrada") {
      newVal = current + qty;
      el.className = "text-2xl font-mono font-bold text-emerald-600";
    } else {
      newVal = Math.max(0, current - qty);
      el.className = "text-2xl font-mono font-bold text-red-600";
    }
    el.innerText = newVal;
  },
  adjustQty(delta) {
    const input = document.getElementById("modal-mov-qty");
    let val = parseInt(input.value) || 0;

    let maxAllowed = Infinity;
    if (this.state.activeModalType === "saida" && this.state.activeModalItem) {
      maxAllowed = this.state.activeModalItem.estoque;
    }

    val = Math.max(1, val + delta);
    if (val > maxAllowed) val = maxAllowed;
    if (maxAllowed <= 0) val = 0;

    input.value = val;
    this.calculateNewStock();
  },
  async confirmMovement() {
    const qty = parseInt(document.getElementById("modal-mov-qty").value) || 0;
    if (qty <= 0) {
      ToastManager.show("A quantidade deve ser maior que zero.", "warning");
      return;
    }

    if (
      this.state.activeModalType === "saida" &&
      qty > this.state.activeModalItem.estoque
    ) {
      ToastManager.show("Quantidade insuficiente em estoque.", "error");
      return;
    }

    const reasonEl = document.getElementById("modal-mov-reason");
    const reason = reasonEl ? reasonEl.value.trim() : "";
    const btn = document.getElementById("modal-mov-confirm");
    const originalText = btn.innerText;
    btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin mx-auto"></i>`;
    lucide.createIcons();
    btn.disabled = true;

    try {
      const success = await FirestoreService.updateStock(
        this.state.activeModalItem.id,
        qty,
        this.state.activeModalType,
        reason,
      );
      if (success) {
        const isEntrada = this.state.activeModalType === "entrada";
        ToastManager.show(
          `${isEntrada ? "Entrada" : "Saída"} registrada com sucesso!`,
          isEntrada ? "entrada" : "success",
        );
        ModalManager.close("modal-movement");
      } else {
        ToastManager.show("Erro ao registrar movimentação.", "error");
      }
    } catch (err) {
      console.error(err);
      ToastManager.show("Ocorreu um erro no servidor.", "error");
    } finally {
      btn.innerText = originalText;
      btn.disabled = false;
    }
  },
  _debouncedRender: Utils.debounce(() => {
    App.renderTableRows();
  }, 300),
  handleSearch(val) {
    this.state.searchTerm = val;
    this.state.searchName = "";
    this.state.searchCode = "";
    this.state.currentPage = 1;
    this._debouncedRender();
  },
  handleAdvancedSearch() {
    const nameVal = document.getElementById("search-name")?.value || "";
    const codeVal = document.getElementById("search-code")?.value || "";
    const statusVal =
      document.getElementById("search-status")?.value || "Todos";
    this.state.searchName = nameVal;
    this.state.searchCode = codeVal;
    this.state.searchTerm = "";
    this.state.statusFilter = statusVal;
    this.state.currentPage = 1;
    this._debouncedRender();
  },
  handleCategory(val) {
    this.state.categoryFilter = val || "Todas";
    this.state.currentPage = 1;
    App.renderTableRows();
  },
  changePage(delta) {
    this.state.currentPage += delta;
    App.renderTableRows();
  },

  handleDescricaoAutoFill() {
    try {
      const descEl = document.getElementById("new-descricao");
      const internoEl = document.getElementById("new-codigo-interno");
      const catEl = document.getElementById("new-categoria");
      const uniEl = document.getElementById("new-unidade");

      if (!descEl) return;

      const raw = (descEl.value || "").toString().trim();

      // Se o campo de descrição for apagado, limpa os outros campos e para a execução
      if (!raw) {
        if (internoEl) internoEl.value = "";
        if (uniEl) uniEl.value = "";
        if (catEl) catEl.value = "";
        return;
      }

      const toKey = (v) => (v == null ? "" : String(v)).trim().toLowerCase();
      const key = toKey(raw);

      // Procura exatamente a mesma descrição no banco de dados
      const match = (FirestoreService.items || []).find(
        (it) => toKey(it.descricao) === key,
      );

      // Se não encontrar correspondência (é um item novo), limpa os campos
      // para evitar que fiquem com dados de um material pesquisado anteriormente
      if (!match) {
        if (internoEl) internoEl.value = "";
        if (uniEl) uniEl.value = "";
        if (catEl) catEl.value = "";
        return;
      }

      // Preenche os outros campos automaticamente com os dados encontrados
      if (internoEl) internoEl.value = match.codigoInterno || "";
      if (uniEl) uniEl.value = match.unidade || match.unidadeEntrada || "";

      try {
        window.App?.renderDepositOptions?.();
      } catch {}

      // Ajusta a categoria no select
      if (catEl) {
        const desired = (match.categoria || "").toString();
        if (desired) {
          const hasOption = Array.from(catEl.options || []).some(
            (o) => o.value === desired,
          );
          if (!hasOption) {
            const opt = document.createElement("option");
            opt.value = desired;
            opt.textContent = desired;
            catEl.appendChild(opt);
          }
          catEl.value = desired;
        }
      }
    } catch (e) {
      console.warn("Autopreenchimento (descrição) falhou:", e);
    }
  },
  async saveNewItem(e) {
    e.preventDefault();

    // Evita erro caso o campo 'new-codigo' não exista mais no layout HTML
    const codigoEl = document.getElementById("new-codigo");
    const codigo = codigoEl ? codigoEl.value.trim() : "";

    const codigoInterno = document
      .getElementById("new-codigo-interno")
      .value.trim();
    const descricao = document.getElementById("new-descricao").value.trim();

    if (!codigoInterno) {
      ToastManager.show("Informe o Cód. Interno (obrigatório).", "error");
      return;
    }

    const duplicado = FirestoreService.items.find((item) => {
      const mesmoCodigo =
        codigo &&
        item.codigo &&
        item.codigo.trim().toUpperCase() === codigo.toUpperCase();
      const mesmaDescricao =
        item.descricao &&
        item.descricao.trim().toUpperCase() === descricao.toUpperCase();
      const mesmoInterno =
        codigoInterno &&
        item.codigoInterno &&
        item.codigoInterno.toString().trim() === codigoInterno;
      return mesmoCodigo || mesmaDescricao || mesmoInterno;
    });

    if (duplicado) {
      let msg = "Material já cadastrado!";
      const dupCodigo = (duplicado.codigo || "").trim().toUpperCase();
      const dupDesc = (duplicado.descricao || "").trim().toUpperCase();
      const inCodigo = (codigo || "").trim().toUpperCase();
      const inDesc = (descricao || "").trim().toUpperCase();
      if (dupCodigo && inCodigo && dupCodigo === inCodigo) {
        msg += ` (Código ${duplicado.codigo} já existe)`;
      } else if (dupDesc && inDesc && dupDesc === inDesc) {
        msg += ` (Descrição idêntica encontrada)`;
      }
      ToastManager.show(msg, "error");
      return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerText;
    btn.innerText = "Salvando...";
    btn.disabled = true;
    const newItem = {
      codigo: codigo,
      codigoInterno: codigoInterno,
      descricao: descricao,
      categoria: document.getElementById("new-categoria").value,
      unidade: document.getElementById("new-unidade").value,
      estoque: parseFloat(document.getElementById("new-estoque").value) || 0,
      estoqueMinimo:
        parseFloat(document.getElementById("new-minimo").value) || 0,
      qtdRessuprimento:
        parseFloat(document.getElementById("new-ressup").value) || 0,
    };
    try {
      const success = await FirestoreService.addItem(newItem);
      if (success) {
        ToastManager.show("Material cadastrado com sucesso!");
        e.target.reset();
      } else {
        ToastManager.show("Erro ao cadastrar material.", "error");
      }
    } catch (err) {
      if (err.message === "permission-denied") {
        ToastManager.show(
          "Acesso negado. Apenas administradores podem cadastrar itens.",
          "error",
        );
      } else {
        ToastManager.show("Erro inesperado ao cadastrar.", "error");
      }
    }
    btn.innerText = originalText;
    btn.disabled = false;
  },
  openStockDetailModal(itemId) {
    const item = FirestoreService.items.find(
      (i) => String(i.id) === String(itemId),
    );
    if (!item) {
      ToastManager.show("Material não encontrado.", "error");
      return;
    }

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const estoque = Number(item.estoque) || 0;
    const reuso = Number(item.estoqueReuso) || 0;
    const total = estoque + reuso;

    setText("detail-desc", item.descricao || "-");
    setText("detail-cat", item.categoria || "-");
    setText("detail-codigo", item.codigo || "-");
    setText("detail-interno", item.codigoInterno || "-");
    setText("detail-uni-ent", item.unidadeEntrada || item.unidade || "-");
    setText("detail-uni-sai", item.unidade || item.unidadeEntrada || "-");
    setText("detail-conversao", App.formatNumber(item.conversao ?? 1, 2));
    setText("detail-est-total", App.formatNumber(total, 0));

    ModalManager.open("modal-details");
  },
  exportToCSV() {
    const data =
      this.state.currentExportData !== null
        ? this.state.currentExportData
        : FirestoreService.items;
    if (!data || data.length === 0) {
      ToastManager.show("Nenhum dado para exportar.", "warning");
      return;
    }

    const delimiter = ";";
    const escapeCsv = (value) => {
      const str = value == null ? "" : String(value);
      return /["\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const header = [
      "Código",
      "Cód. Interno",
      "Descrição",
      "Categoria",
      "Unidade",
      "Estoque",
      "Mínimo",
      "Ressuprimento",
    ].join(delimiter);

    const rows = data.map((item) =>
      [
        item.codigo || "",
        item.codigoInterno || "",
        item.descricao || "",
        item.categoria || "",
        item.unidade || item.unidadeEntrada || "",
        item.estoque ?? 0,
        item.estoqueMinimo ?? 0,
        item.qtdRessuprimento ?? 0,
      ]
        .map(escapeCsv)
        .join(delimiter),
    );

    const csvContent = `\uFEFF${header}\n${rows.join("\n")}`;
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `estoque-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  exportToPDF() {
    if (!window.jspdf) {
      ToastManager.show("Módulo PDF carregando...", "warning");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("landscape");

    const data =
      this.state.currentExportData !== null
        ? this.state.currentExportData
        : FirestoreService.items;
    if (!data || data.length === 0) {
      ToastManager.show("Nenhum dado para exportar.", "warning");
      return;
    }

    doc.setFontSize(14);
    doc.text("Relatório de Posição de Estoque - SEROB", 14, 15);
    doc.setFontSize(10);
    doc.text(`Emitido em: ${new Date().toLocaleString("pt-BR")}`, 14, 22);

    const tableData = data.map((item) => [
      item.codigo || "-",
      item.codigoInterno || "-",
      item.descricao || "-",
      item.categoria || "-",
      item.unidade || item.unidadeEntrada || "-",
      item.estoque ?? 0,
      item.estoqueMinimo ?? 0,
      Number(item.estoque) <= Number(item.estoqueMinimo) ? "Crítico" : "Normal",
    ]);

    doc.autoTable({
      startY: 28,
      head: [
        [
          "Código",
          "Cód. Int.",
          "Descrição",
          "Categoria",
          "Unid.",
          "Saldo",
          "Mínimo",
          "Status",
        ],
      ],
      body: tableData,
      theme: "striped",
      styles: { fontSize: 8 },
      headStyles: { fillColor: [37, 99, 235] },
    });

    doc.save(`relatorio_estoque_${new Date().getTime()}.pdf`);
    ToastManager.show("Relatório PDF gerado com sucesso!", "success");
  },
};

const App = {
  currentTab: "dashboard",
  depositsChartInstance: null,
  monthlyChartInstance: null,
  statusChartInstance: null,
  alertedLowStock: false,
  dashboardPeriod: 30,
  dashboardCategory: "Todas",
  isDesktopCollapsed: false,
  changeDashboardPeriod(days) {
    this.dashboardPeriod = days;
    this.renderDashboard();
  },
  changeDashboardCategory(cat) {
    this.dashboardCategory = cat;
    this.renderDashboard();
  },
  toggleDesktopSidebar() {
    const sidebar = document.getElementById("sidebar");
    this.isDesktopCollapsed = !this.isDesktopCollapsed;
    
    const texts = document.querySelectorAll(".sidebar-text");
    const logoText = document.getElementById("sidebar-logo-text");
    const arrow = document.getElementById("arrow-material");
    const icon = document.getElementById("sidebar-toggle-icon");
    const subMenu = document.getElementById("submenu-material");
    
    if (this.isDesktopCollapsed) {
      sidebar.classList.replace("xl:w-72", "xl:w-20");
      if (subMenu && !subMenu.classList.contains("hidden")) {
        this.toggleSubmenu('submenu-material', true); // Ignora a expansão automática
      }
      texts.forEach(t => t.classList.add("hidden"));
      if(logoText) logoText.classList.add("hidden");
      if(arrow) arrow.classList.add("hidden");
      if(icon) icon.classList.add("rotate-180");
    } else {
      sidebar.classList.replace("xl:w-20", "xl:w-72");
      setTimeout(() => {
        texts.forEach(t => t.classList.remove("hidden"));
        if(logoText) logoText.classList.remove("hidden");
        if(arrow) arrow.classList.remove("hidden");
      }, 150);
      if(icon) icon.classList.remove("rotate-180");
    }
  },
  getPredictionModel(dashboardPeriod) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - dashboardPeriod);
    const dailyConsumptionMap = {};

    (FirestoreService.movements || []).forEach((m) => {
      if (m.type === "saida" && m.date && m.date.toDate) {
        const d = m.date.toDate();
        if (d >= targetDate) {
          const diffTime = d - targetDate;
          const dayIndex = Math.floor(diffTime / (1000 * 60 * 60 * 24));
          if (!dailyConsumptionMap[m.itemId])
            dailyConsumptionMap[m.itemId] = {};
          dailyConsumptionMap[m.itemId][dayIndex] =
            (dailyConsumptionMap[m.itemId][dayIndex] || 0) +
            (Number(m.qty) || 0);
        }
      }
    });

    return (item) => {
      const itemDaily = dailyConsumptionMap[item.id] || {};
      let sumX = 0,
        sumY = 0,
        sumXY = 0,
        sumXX = 0;
      for (let i = 0; i <= dashboardPeriod; i++) {
        const y = itemDaily[i] || 0;
        sumX += i;
        sumY += y;
        sumXY += i * y;
        sumXX += i * i;
      }
      const n = dashboardPeriod + 1;
      const denominator = n * sumXX - sumX * sumX;
      const m = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator; // Slope (Tendência)
      const b = (sumY - m * sumX) / n;
      const avg = sumY / n;

      let projectedRate = avg;
      if (m !== 0) {
        const endRate = m * dashboardPeriod + b;
        projectedRate = Math.max(0, (endRate + avg) / 2); // Suaviza o peso da regressão
      }
      if (avg === 0) projectedRate = 0;

      let suggQty = Math.max(
        Number(item.qtdRessuprimento) || 0,
        Number(item.estoqueMinimo) * 2 - Number(item.estoque),
      );
      if (projectedRate > 0) {
        const optimalStock = Math.ceil(
          projectedRate * dashboardPeriod + Number(item.estoqueMinimo),
        );
        const needed = optimalStock - Number(item.estoque);
        if (needed > suggQty) suggQty = needed;
      }

      return { m, avg, projectedRate, suggQty };
    };
  },
  sendPurchaseAlert() {
    const criticalItems = FirestoreService.items.filter(
      (i) => (Number(i.estoque) || 0) <= (Number(i.estoqueMinimo) || 0),
    );
    if (criticalItems.length === 0)
      return ToastManager.show("Nenhum item crítico para avisar.", "warning");

    const predictor = this.getPredictionModel(this.dashboardPeriod);
    const btn = document.getElementById("btn-avisar-compras");
    const originalHTML = btn ? btn.innerHTML : "";

    if (btn) {
      btn.innerHTML = `<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i> Processando IA...`;
      btn.disabled = true;
      lucide.createIcons();
    }

    let body =
      "Prezados(as) do setor de Compras,%0D%0A%0D%0AIdentificamos através do sistema preditivo que os seguintes itens atingiram nível crítico. As quantidades sugeridas foram projetadas por nossa IA visando a estabilidade do estoque:%0D%0A%0D%0A";
    criticalItems.forEach((i) => {
      const { suggQty } = predictor(i);
      body += `- ${i.codigo || "S/N"} | ${i.descricao} | Saldo Atual: ${i.estoque} | Sugestão Compra: ${suggQty}%0D%0A`;
    });

    setTimeout(() => {
      if (btn) {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        lucide.createIcons();
      }
      window.location.href = `mailto:compras@suaempresa.com?subject=ALERTA AUTOMÁTICO: Previsão de Reposição de Estoque&body=${body}`;
      ToastManager.show(
        "Alerta estruturado e enviado ao cliente de email!",
        "success",
      );
    }, 1200);
  },
  formatNumber(value, maxFractionDigits = 2) {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : 0;
    return new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
    }).format(safe);
  },

  calcOutOfStock() {
    return (FirestoreService.items || []).filter(
      (i) => (Number(i?.estoque) || 0) <= 0,
    ).length;
  },

  updateKpis() {
    const el = document.getElementById("kpi-out-of-stock");
    if (!el) return;
    el.textContent = this.calcOutOfStock();
  },

  renderDepositOptions() {
    const sel = document.getElementById("new-categoria");
    const filterSel = document.getElementById("filter-categoria");

    if (!sel && !filterSel) return;

    let depositsList = (FirestoreService.deposits || [])
      .map((d) => (d?.name ?? d?.categoria ?? d?.id ?? "").toString())
      .map((s) => s.trim())
      .filter(Boolean);

    if (depositsList.length === 0) {
      depositsList = [
        ...new Set(FirestoreService.items.map((i) => i.categoria)),
      ]
        .filter(Boolean)
        .map((c) => c.toString().trim());
    }

    const deposits = [...new Set(depositsList)]
      .filter((s) => s.toUpperCase() !== "DEPÓSITO GERAL")
      .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));

    if (sel) {
      const current = (sel.value || "").toString();
      sel.innerHTML = "";

      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Selecione o depósito";
      ph.disabled = true;
      ph.selected = !current;
      sel.appendChild(ph);

      deposits.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });

      if (current) {
        const has = Array.from(sel.options).some((o) => o.value === current);
        if (!has) {
          const opt = document.createElement("option");
          opt.value = current;
          opt.textContent = current;
          sel.appendChild(opt);
        }
        sel.value = current;
      }
    }

    if (filterSel) {
      const currentFilter = InventoryController.state.categoryFilter || "Todas";
      const has = Array.from(filterSel.options).some(
        (o) => o.value === currentFilter,
      );
      if (has) {
        filterSel.value = currentFilter;
      } else {
        filterSel.value = "Todas";
        InventoryController.state.categoryFilter = "Todas";
      }
    }
  },
  async init() {
    AuthService.restoreSession();
    await FirestoreService.init();
    document.getElementById("loading-screen").classList.add("hidden");
    const loginForm = document.getElementById("login-form");
    if (loginForm)
      loginForm.addEventListener("submit", AuthController.handleLogin);
    if (AuthService.getCurrentUser()) {
      this.initLayout();
    } else {
      document.getElementById("login-layout").classList.add("hidden");
      document.getElementById("landing-layout").classList.remove("hidden");
    }
    lucide.createIcons();
  },
  refreshUI() {
    if (!AuthService.getCurrentUser()) return;
    if (this.currentTab === "dashboard") {
      this.renderDashboard();
    } else if (
      this.currentTab === "stock-search" ||
      this.currentTab === "stock-move"
    ) {
      this.renderTableRows();
    } else if (this.currentTab === "movement-search") {
      if (typeof this.renderHistoryTableRows === "function") {
        this.renderHistoryTableRows();
      }
    }

    this.updateKpis();
  },
  resetData() {
    if (
      confirm(
        "ATENÇÃO: Isso irá apagar todos os dados no Firebase e restaurar os itens originais. Deseja continuar?",
      )
    ) {
      FirestoreService.resetData();
    }
  },
  initLayout() {
    document.getElementById("login-layout").classList.add("hidden");
    document.getElementById("landing-layout").classList.add("hidden");
    const appLayout = document.getElementById("app-layout");
    appLayout.classList.remove("hidden");
    appLayout.classList.add("animate-fade-in");
    appLayout.classList.add("flex");
    this.updateUserProfile();
    try {
      this.renderDepositOptions();
      window.InventoryController?.handleCodigoInternoAutoFill?.();
    } catch {}

    const contentArea = document.getElementById("content-area");
    const backToTopBtn = document.getElementById("back-to-top");
    if (contentArea && backToTopBtn) {
      contentArea.addEventListener("scroll", () => {
        if (contentArea.scrollTop > 300) {
          backToTopBtn.classList.remove(
            "opacity-0",
            "translate-y-10",
            "pointer-events-none",
          );
        } else {
          backToTopBtn.classList.add(
            "opacity-0",
            "translate-y-10",
            "pointer-events-none",
          );
        }
      });
    }

    this.navigate(this.currentTab);

    if (FirestoreService.isNewUser) {
      ModalManager.open("modal-onboarding");
      FirestoreService.isNewUser = false; // Garante que abra apenas na primeira vez
    }
  },
  async completeOnboarding() {
    const compInput = document.getElementById("onboard-company");
    const compName = (compInput?.value || "").trim() || "Minha Empresa";
    const user = auth.currentUser;
    if (user) {
      await setDoc(
        doc(db, "users", user.uid),
        { tenantName: compName },
        { merge: true },
      );
      if (FirestoreService.profile)
        FirestoreService.profile.tenantName = compName;
      App.updateUserProfile();
    }
    ModalManager.close("modal-onboarding");
    ToastManager.show(`Ambiente isolado criado para ${compName}!`, "success");
  },
  updateUserProfile() {
    const user = AuthService.getCurrentUser();
    if (!user) return;
    const firstName =
      (user.name || "Convidado").toString().trim().split(" ")[0] || "Convidado";
    document.getElementById("user-name").innerText = firstName;
    document.getElementById("user-role").innerText =
      user.label || (user.role === "admin" ? "Administrador" : "Usuário");

    const tNameEl = document.getElementById("tenant-name");
    if (tNameEl) tNameEl.innerText = user.tenantName || "Sua Empresa";

    const iconHtml = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="w-full h-full p-1.5 fill-current"><path d="M15.71,12.71a6,6,0,1,0-7.42,0,10,10,0,0,0-6.22,8.18,1,1,0,0,0,2,.22,8,8,0,0,1,15.9,0,1,1,0,0,0,1,.89h.11a1,1,0,0,0,.88-1.1A10,10,0,0,0,15.71,12.71ZM12,12a4,4,0,1,1,4-4A4,4,0,0,1,12,12Z"/></svg>`;
    document.getElementById("user-avatar").innerHTML = iconHtml;
    const adminTools = document.getElementById("admin-tools");
    const navMatReg = document.getElementById("nav-mat-register");
    const navSaas = document.getElementById("nav-saas-admin");

    if (AuthService.isAdmin()) {
      if (adminTools) adminTools.classList.remove("hidden");
      if (navMatReg) navMatReg.classList.remove("hidden");
      if (navSaas) navSaas.classList.remove("hidden");
    } else {
      if (adminTools) adminTools.classList.add("hidden");
      if (navMatReg) navMatReg.classList.add("hidden");
      if (navSaas) navSaas.classList.add("hidden");
    }
  },
  toggleSubmenu(id, bypassExpand = false) {
    if (this.isDesktopCollapsed && !bypassExpand) {
      this.toggleDesktopSidebar();
    }
    const el = document.getElementById(id);
    const arrow = document.getElementById("arrow-" + id.split("-")[1]);
    if (el.classList.contains("hidden")) {
      el.classList.remove("hidden");
      arrow.classList.add("rotate-180");
    } else {
      el.classList.add("hidden");
      arrow.classList.remove("rotate-180");
    }
  },
  navigate(tab) {
    this.currentTab = tab;

    const pageTitles = {
      dashboard: "Visão Geral",
      "stock-search": "Pesquisa de Estoque",
      "stock-move": "Movimentações",
      "movement-search": "Histórico do Sistema",
      "material-register": "Cadastro de Material",
      "saas-admin": "Gestão Multiempresa (SaaS)",
    };
    const topbarTitle = document.getElementById("topbar-title");
    if (topbarTitle) topbarTitle.innerText = pageTitles[tab] || "Sistema";

    document.querySelectorAll("nav button").forEach((b) => {
      if (b.id !== "nav-material") {
        if (b.parentElement.id === "submenu-material") {
          b.className =
            "w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800/50 transition-all";
        } else {
          b.className =
            b.id === "nav-saas-admin"
              ? b.className.replace("text-purple-300", "text-purple-400")
              : "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold text-slate-300 hover:text-white hover:bg-slate-800/50 transition-all duration-200";
        }
      }
    });

    if (tab === "dashboard") {
      const navDash = document.getElementById("nav-dashboard");
      if (navDash)
        navDash.className =
          "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold bg-brand-600 text-white shadow-lg shadow-brand-600/20 transition-all duration-200";
      this.renderDashboard();
    } else if (
      tab.startsWith("stock-") ||
      tab.startsWith("movement-") ||
      tab.startsWith("material-")
    ) {
      const sub = document.getElementById("submenu-material");
      if (sub && sub.classList.contains("hidden"))
        this.toggleSubmenu("submenu-material");
      const activeSubClass =
        "w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-bold bg-slate-800 text-white transition-all";
      const tabIdMap = {
        "stock-search": "nav-stock-search",
        "stock-move": "nav-stock-move",
        "movement-search": "nav-mov-search",
        "material-register": "nav-mat-register",
      };
      const targetId = tabIdMap[tab];
      if (targetId) {
        const el = document.getElementById(targetId);
        if (el) el.className = activeSubClass;
      }

      if (tab === "material-register" && !AuthService.isAdmin()) {
        ToastManager.show("Área restrita para administradores.", "warning");
        return this.navigate("dashboard");
      }

      if (tab === "stock-search") this.renderStockSearch();
      else if (tab === "stock-move")
        this.renderMovementsLayout("Movimentação de Estoque");
      else if (tab === "movement-search") this.renderHistoryLayout();
      else if (tab === "material-register") this.renderRegisterLayout();
    } else if (tab === "saas-admin") {
      if (!AuthService.isAdmin()) return this.navigate("dashboard");
      const saasBtn = document.getElementById("nav-saas-admin");
      if (saasBtn)
        saasBtn.className =
          "w-full hidden flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold bg-purple-500/10 text-purple-300 border border-purple-500/20 transition-all duration-200";
      this.renderSaaSAdmin();
    }
    const sidebar = document.getElementById("sidebar");
    if (sidebar && !sidebar.classList.contains("-translate-x-full"))
      this.toggleSidebar();
  },
  toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("mobile-overlay");
    sidebar.classList.toggle("-translate-x-full");
    overlay.classList.toggle("hidden");
    overlay.classList.toggle("opacity-0");
  },
  scrollToTop() {
    const contentArea = document.getElementById("content-area");
    if (contentArea) {
      contentArea.scrollTo({ top: 0, behavior: "smooth" });
    }
  },
  async logout() {
    await AuthService.logout();
  },

  openPasswordModal() {
    const u = AuthService.getCurrentUser();
    if (!u) return;
    document.getElementById("pwd-current").value = "";
    document.getElementById("pwd-new").value = "";
    document.getElementById("pwd-confirm").value = "";
    ModalManager.open("modal-password");
  },
  renderStockSearch() {
    const container = document.getElementById("content-area");
    if (!AuthService.getCurrentUser()) return;
    container.innerHTML = `
      <div class="space-y-4 h-full flex flex-col animate-fade-in max-w-7xl mx-auto">
        <div class="bg-white p-6 rounded-3xl border border-slate-200/60 shadow-sm relative overflow-hidden">
          <div class="absolute top-0 left-0 w-1 h-full bg-brand-500"></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4 flex items-center gap-2"><i data-lucide="filter" class="w-4 h-4"></i> Filtros de Busca</p>
          <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div class="md:col-span-3"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Nome / Descrição</label><input type="text" id="search-name" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm" placeholder="Digite o nome..." onkeyup="InventoryController.handleAdvancedSearch()"></div>
            <div class="md:col-span-2"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Código</label><input type="text" id="search-code" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm" placeholder="Ex: 12345" onkeyup="InventoryController.handleAdvancedSearch()"></div>
            <div class="md:col-span-2"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Status</label><select id="search-status" onchange="InventoryController.handleAdvancedSearch()" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm cursor-pointer appearance-none"><option value="Todos">Todos</option><option value="Normal">Normal</option><option value="Alerta">Alerta</option><option value="Critico">Crítico</option><option value="Esgotado">Esgotado</option></select></div>
            <div class="md:col-span-2"><button onclick="InventoryController.handleAdvancedSearch()" class="w-full px-4 py-3 bg-brand-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-brand-700 transition-all flex items-center justify-center gap-2 active:scale-95"><i data-lucide="refresh-cw" class="w-4 h-4"></i> Atualizar</button></div>
            <div class="md:col-span-3 flex gap-2">
              <button onclick="InventoryController.exportToCSV()" class="flex-1 px-4 py-3 bg-emerald-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar Excel"><i data-lucide="file-spreadsheet" class="w-4 h-4"></i> CSV</button>
              <button onclick="InventoryController.exportToPDF()" class="flex-1 px-4 py-3 bg-red-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-red-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar PDF"><i data-lucide="file-text" class="w-4 h-4"></i> PDF</button>
            </div>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col shadow-none md:shadow-sm">
          <div class="overflow-auto flex-1 custom-scrollbar">
            <table class="block md:table w-full text-sm text-left relative">
              <thead class="hidden md:table-header-group bg-slate-50/80 backdrop-blur-md text-slate-500 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-20 border-b border-slate-200/80">
                <tr><th class="px-4 py-3 w-28">Código</th><th class="px-4 py-3 w-24">Cód. Int.</th><th class="px-4 py-3 min-w-[200px]">Descrição</th><th class="px-4 py-3 text-center w-20">Unid.</th><th class="px-4 py-3 text-center w-24">Saldo</th><th class="px-4 py-3 text-center w-20">Mín.</th><th class="px-4 py-3 text-center w-20">Ressup.</th><th class="px-4 py-3 text-center w-24">Status</th><th class="px-4 py-3 text-right w-16"></th></tr>
              </thead>
              <tbody id="inventory-body" class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 bg-transparent md:bg-white space-y-4 md:space-y-0"></tbody>
            </table>
          </div>
          <div class="bg-white md:bg-slate-50 px-4 py-3 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3 rounded-b-3xl md:rounded-none mt-2 md:mt-0 shadow-sm md:shadow-none">
            <div class="text-xs text-slate-500">
              Total: <span id="total-records" class="font-bold">0</span> <span class="mx-2">•</span> Página <span id="current-page" class="font-bold text-slate-700">1</span> de <span id="total-pages" class="font-bold text-slate-700">1</span>
            </div>
            <div class="flex items-center gap-2">
              <button id="btn-prev-page" onclick="InventoryController.changePage(-1)" class="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
              <button id="btn-next-page" onclick="InventoryController.changePage(1)" class="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
            </div>
          </div>
        </div>
      </div>`;
    lucide.createIcons();
    this.renderTableRows();
  },
  renderDashboard() {
    const container = document.getElementById("content-area");
    const user = AuthService.getCurrentUser();
    if (!user) return;

    const now = new Date();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - this.dashboardPeriod);

    const categoriesList = [
      "Todas",
      ...new Set(
        FirestoreService.items.map((i) => i.categoria).filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "pt-BR"));

    const itemCatMap = {};
    FirestoreService.items.forEach((i) => (itemCatMap[i.id] = i.categoria));

    const baseItems =
      this.dashboardCategory === "Todas"
        ? FirestoreService.items
        : FirestoreService.items.filter(
            (i) => i.categoria === this.dashboardCategory,
          );
    const baseMovements = (FirestoreService.movements || []).filter((m) =>
      this.dashboardCategory === "Todas"
        ? true
        : itemCatMap[m.itemId] === this.dashboardCategory,
    );

    let totalEntradas = 0;
    let totalSaidas = 0;
    let totalEstoque = 0;
    let valorAlocado = 0;
    const userMovements = {};
    let totalMovs = 0;

    baseItems.forEach((i) => {
      totalEstoque += Number(i.estoque) || 0;
      valorAlocado += (Number(i.estoque) || 0) * (Number(i.custoMedio) || 0);
    });

    baseMovements.forEach((m) => {
      if (m.date && m.date.toDate) {
        const d = m.date.toDate();
        if (d >= targetDate) {
          if (m.type === "entrada") totalEntradas += Number(m.qty) || 0;
          if (m.type === "saida") totalSaidas += Number(m.qty) || 0;

          const uName = m.userName || "Desconhecido";
          userMovements[uName] = (userMovements[uName] || 0) + 1;
          totalMovs++;
        }
      }
    });

    const predictor = this.getPredictionModel(this.dashboardPeriod);

    const stats = {
      totalItems: baseItems.length,
      lowStock: baseItems.filter((i) => {
        const est = Number(i.estoque) || 0;
        const min = Number(i.estoqueMinimo) || 0;
        return est > 0 && est <= min;
      }).length,
      outOfStock: baseItems.filter((i) => (Number(i.estoque) || 0) <= 0).length,
      categories: [
        ...new Set(baseItems.map((i) => i.categoria).filter(Boolean)),
      ].length,
    };
    const alertItems = baseItems
      .filter(
        (i) => (Number(i.estoque) || 0) <= (Number(i.estoqueMinimo) || 0) * 1.4,
      )
      .sort((a, b) => {
        const estA = Number(a.estoque) || 0;
        const minA = Number(a.estoqueMinimo) || 0;
        const estB = Number(b.estoque) || 0;
        const minB = Number(b.estoqueMinimo) || 0;
        const ratioA = minA > 0 ? estA / minA : estA <= 0 ? 0 : 1;
        const ratioB = minB > 0 ? estB / minB : estB <= 0 ? 0 : 1;
        return ratioA - ratioB;
      });

    // Alerta automático ao entrar
    if (stats.lowStock > 0 && !this.alertedLowStock) {
      setTimeout(() => {
        ToastManager.show(
          `Atenção: ${stats.lowStock} item(ns) atingiram o nível crítico de estoque!`,
          "warning",
        );
      }, 800);
      this.alertedLowStock = true;
    }

    const goal = Math.round((2000 / 30) * this.dashboardPeriod);

    container.innerHTML = `
      <div class="space-y-5 animate-fade-in pb-10 max-w-[1600px] mx-auto pt-2">
        
        <!-- FILTROS BI (SLICERS) -->
        <div class="flex flex-col xl:flex-row justify-between items-center gap-4 bg-white p-4 rounded-3xl border border-slate-200/60 shadow-sm relative z-20">
          <div class="flex items-center gap-3 w-full xl:w-auto">
             <div class="p-2 bg-gradient-to-br from-brand-500 to-indigo-600 text-white rounded-xl shadow-lg shadow-brand-500/20"><i data-lucide="bar-chart-2" class="w-6 h-6"></i></div>
             <div class="flex-1">
                <h2 class="text-lg font-bold text-slate-800 leading-tight">Painel Executivo (Power BI)</h2>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Inteligência Estratégica</p>
             </div>
          </div>
          <div class="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
             <div class="relative min-w-[220px]">
                <select onchange="App.changeDashboardCategory(this.value)" class="appearance-none w-full bg-slate-50 border border-slate-200 text-slate-700 py-2.5 pl-4 pr-10 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm font-semibold cursor-pointer shadow-inner">
                  ${categoriesList.map((c) => `<option value="${c}" ${this.dashboardCategory === c ? "selected" : ""}>${c}</option>`).join("")}
                </select>
                <i data-lucide="filter" class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-brand-500 pointer-events-none"></i>
             </div>
             <div class="flex gap-1 bg-slate-50 p-1 rounded-xl border border-slate-200">
               <button onclick="App.changeDashboardPeriod(7)" class="${this.dashboardPeriod === 7 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:bg-slate-200/50"} flex-1 px-4 py-2 rounded-lg text-xs transition-all duration-200">7 Dias</button>
               <button onclick="App.changeDashboardPeriod(30)" class="${this.dashboardPeriod === 30 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:bg-slate-200/50"} flex-1 px-4 py-2 rounded-lg text-xs transition-all duration-200">30 Dias</button>
               <button onclick="App.changeDashboardPeriod(90)" class="${this.dashboardPeriod === 90 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:bg-slate-200/50"} flex-1 px-4 py-2 rounded-lg text-xs transition-all duration-200">90 Dias</button>
             </div>
          </div>
        </div>

        <!-- 5 KPIs -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          ${this._createCard("Capital Alocado", Utils.formatCurrency(valorAlocado), "dollar-sign", "purple")}
          ${this._createCard("Itens em Estoque", App.formatNumber(totalEstoque, 0), "package", "blue")}
          ${this._createCard("Entradas (Un)", App.formatNumber(totalEntradas, 0), "arrow-down-to-line", "green")}
          ${this._createCard("Saídas (Un)", App.formatNumber(totalSaidas, 0), "arrow-up-from-line", "amber")}
          ${this._createCard("Itens Críticos", stats.lowStock, "alert-triangle", "red")}
    </div>

        <!-- MAIN BI GRID (Tabela + Saude) -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 relative z-10">
          <div class="lg:col-span-2 bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col relative">
            <div class="p-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white/80 backdrop-blur-md sticky top-0 z-10">
               <h3 class="font-bold text-slate-900 flex items-center gap-2"><i data-lucide="brain-circuit" class="w-5 h-5 text-indigo-500"></i> Previsão & Alertas IA</h3>
               <div class="flex gap-2 w-full sm:w-auto">
                 <button id="btn-avisar-compras" onclick="App.sendPurchaseAlert()" class="flex-1 sm:flex-none text-[11px] flex justify-center items-center gap-1.5 font-bold text-white bg-indigo-600 px-3 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors shadow-sm active:scale-95"><i data-lucide="zap" class="w-3.5 h-3.5"></i> Automação Email</button>
                 <button onclick="App.navigate('stock-search')" class="flex-1 sm:flex-none text-[11px] flex justify-center items-center font-bold text-brand-600 bg-brand-50 px-3 py-2.5 rounded-xl hover:bg-brand-100 transition-colors active:scale-95">Ver Estoque</button>
               </div>
            </div>
            <div class="overflow-x-auto p-2 md:p-0 custom-scrollbar max-h-96"><table class="block md:table w-full text-sm text-left"><thead class="hidden md:table-header-group bg-slate-50 text-slate-500 font-semibold uppercase text-[10px] tracking-wider sticky top-0 z-20"><tr><th class="px-5 py-3">Material / Tendência</th><th class="px-5 py-3 text-right">Saldo</th><th class="px-5 py-3 text-center">Esgota Em ✨</th><th class="px-5 py-3 text-center">Status</th></tr></thead><tbody class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 space-y-3 md:space-y-0">${
              alertItems
                .slice(0, 7)
                .map((item, index) => {
                  const isCritical =
                    (Number(item.estoque) || 0) <=
                    (Number(item.estoqueMinimo) || 0);
                  const statusClass = isCritical
                    ? "bg-red-100 text-red-800 border-red-200"
                    : "bg-amber-100 text-amber-800 border-amber-200";
                  const statusText = isCritical ? "Crítico" : "Alerta";
                  const stockClass = isCritical
                    ? "text-red-600 animate-pulse"
                    : "text-amber-600";

                  const { m, projectedRate, suggQty } = predictor(item);

                  let trendHtml = "";
                  if (m > 0.05)
                    trendHtml = `<span class="text-[10px] font-bold text-red-500 flex items-center gap-1 mt-1" title="Consumo acelerando: +${(m * 30).toFixed(1)}/mês"><i data-lucide="trending-up" class="w-3 h-3"></i> Alta Demanda</span>`;
                  else if (m < -0.05)
                    trendHtml = `<span class="text-[10px] font-bold text-emerald-500 flex items-center gap-1 mt-1" title="Consumo caindo: ${(m * 30).toFixed(1)}/mês"><i data-lucide="trending-down" class="w-3 h-3"></i> Baixa Demanda</span>`;
                  else if (projectedRate > 0)
                    trendHtml = `<span class="text-[10px] font-bold text-slate-400 flex items-center gap-1 mt-1"><i data-lucide="minus" class="w-3 h-3"></i> Consumo Estável</span>`;

                  let prevText =
                    '<span class="text-slate-400 italic text-[11px]">Sem saída no período</span>';
                  if (Number(item.estoque) <= 0) {
                    prevText = `<div class="font-bold text-red-600 text-sm">Esgotado</div><div class="text-slate-400 font-normal text-[10px]">Imediata reposição</div>`;
                  } else if (projectedRate > 0.01) {
                    const daysLeft = Math.floor(
                      (Number(item.estoque) || 0) / projectedRate,
                    );
                    const esgotDate = new Date();
                    esgotDate.setDate(esgotDate.getDate() + daysLeft);
                    const dateStr = esgotDate.toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "2-digit",
                    });
                    const colorDate =
                      daysLeft <= 7 ? "text-red-600" : "text-slate-800";
                    prevText = `<div class="font-bold ${colorDate} text-sm">${dateStr}</div><div class="text-slate-400 font-normal text-[10px]">Restam ~${daysLeft} dias</div>`;
                  }

                  const suggHtml = isCritical
                    ? `<div class="text-indigo-600 font-bold mt-2 text-[10px] bg-indigo-50 px-2.5 py-1 rounded border border-indigo-100 w-max md:mx-auto" title="IA Sugere reposição baseada na curva de regressão">Sugerido: Compra de ${suggQty}</div>`
                    : "";

                  return `<tr class="hover:bg-slate-50/80 transition-all duration-300 group animate-fade-in opacity-0 block md:table-row bg-white md:bg-transparent border border-slate-200 md:border-none rounded-2xl md:rounded-none p-4 md:p-0" style="animation-delay: ${index * 50}ms;">
                    <td class="block md:table-cell px-0 md:px-5 py-2 md:py-3 border-b border-slate-100 md:border-none"><div class="font-medium text-slate-900 truncate max-w-xs" title="${Utils.escapeHTML(item.descricao)}">${Utils.escapeHTML(item.descricao)}</div>${trendHtml}</td>
                    <td class="flex justify-between items-center md:table-cell px-0 md:px-5 py-2 md:py-3 text-left md:text-right font-mono font-bold ${stockClass} border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase">Saldo</span><div class="flex flex-col items-end"><span>${Number(item.estoque) || 0}</span><span class="text-[9px] text-slate-400 font-normal">Mín: ${Number(item.estoqueMinimo) || 0}</span></div></td>
                    <td class="flex flex-col justify-center items-end md:items-center md:table-cell px-0 md:px-5 py-3 md:py-3 text-right md:text-center border-b border-slate-100 md:border-none"><div class="md:hidden font-bold text-[10px] text-slate-400 uppercase mb-1">Esgota Em</div>${prevText}</td>
                    <td class="flex flex-col items-end md:items-center justify-center md:table-cell px-0 md:px-5 py-3 md:py-3 border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase mb-1">Status</span><span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase border ${statusClass}">${statusText}</span>${suggHtml}</td>
                  </tr>`;
                })
                .join("") ||
              `<tr class="block md:table-row bg-white md:bg-transparent rounded-2xl md:rounded-none border border-slate-200 md:border-none"><td colspan="5" class="px-6 py-12 text-center text-slate-400 italic block md:table-cell">Tudo em ordem! Nenhum alerta.</td></tr>`
            }</tbody></table></div>
          </div>
          <div class="flex flex-col gap-6">
            <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col h-full relative">
              <h3 class="font-bold text-slate-900 mb-2 flex items-center gap-2"><i data-lucide="activity" class="w-5 h-5 text-blue-500"></i> Saúde do Estoque</h3>
              <div class="relative w-full h-48 mt-2 flex-1"><canvas id="statusChart"></canvas></div>
            </div>
            <div class="bg-white rounded-3xl p-5 shadow-sm border border-slate-200/60">
               <div class="flex justify-between items-end mb-2">
                   <div>
                      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Meta Consumo (${this.dashboardPeriod}d)</span>
                      <span class="text-base font-bold text-slate-700">${App.formatNumber(totalSaidas, 0)} <span class="text-xs font-medium text-slate-400">/ ${App.formatNumber(goal, 0)} max.</span></span>
                   </div>
                   <span class="text-xs font-bold ${totalSaidas > goal ? "text-red-500" : "text-emerald-500"}">${Math.min(100, (totalSaidas / goal) * 100).toFixed(1)}%</span>
               </div>
               <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                   <div class="${totalSaidas > goal ? "bg-red-500" : "bg-gradient-to-r from-emerald-400 to-emerald-500"} h-full rounded-full transition-all duration-1000" style="width: ${Math.min(100, (totalSaidas / goal) * 100)}%"></div>
               </div>
            </div>
          </div>
        </div>
        
        <!-- BOTTOM GRAPHS -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 relative z-10">
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col">
            <h3 class="font-bold text-slate-900 mb-4 flex items-center gap-2"><i data-lucide="bar-chart" class="w-5 h-5 text-brand-500"></i> ${this.dashboardCategory === "Todas" ? "Volume por Categoria" : "Top 10 Itens (Volume)"}</h3>
            <div class="relative w-full h-64"><canvas id="depositsChart"></canvas></div>
          </div>
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col">
            <h3 class="font-bold text-slate-900 mb-4 flex items-center gap-2"><i data-lucide="line-chart" class="w-5 h-5 text-purple-500"></i> Projeção e Consumo</h3>
            <div class="relative w-full h-64"><canvas id="monthlyChart"></canvas></div>
          </div>
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col"><h3 class="font-bold text-slate-900 mb-6 flex items-center gap-2"><i data-lucide="users" class="w-5 h-5 text-amber-500"></i> Top Usuários (${this.dashboardPeriod}d)</h3><div class="space-y-5 overflow-y-auto custom-scrollbar flex-1 pr-2">
          ${
            Object.entries(userMovements)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([uName, count]) => {
                const percent = Math.min(100, (count / (totalMovs || 1)) * 100);
                return `<div><div class="flex justify-between text-xs mb-1.5 font-medium"><span class="text-slate-700 truncate w-3/4 flex items-center gap-1.5"><i data-lucide="user" class="w-3 h-3 text-slate-400"></i>${Utils.escapeHTML(uName.split(" ")[0])}</span><span class="text-slate-500 font-mono">${count} movs</span></div><div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden"><div class="bg-amber-400 h-1.5 rounded-full transition-all duration-1000" style="width: ${percent}%"></div></div></div>`;
              })
              .join("") ||
            `<p class="text-xs text-slate-400 italic text-center mt-4">Nenhuma movimentação no período</p>`
          }
          </div></div>
        </div>
      </div>`;
    lucide.createIcons();
    this.renderChart();
  },
  _createCard(title, value, icon, color) {
    const gradients = {
      blue: "bg-gradient-to-br from-blue-500 to-blue-700 shadow-blue-500/30",
      red: "bg-gradient-to-br from-rose-500 to-rose-700 shadow-rose-500/30",
      green:
        "bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-emerald-500/30",
      amber:
        "bg-gradient-to-br from-amber-500 to-amber-700 shadow-amber-500/30",
      purple:
        "bg-gradient-to-br from-indigo-500 to-indigo-700 shadow-indigo-500/30",
    };
    const grad = gradients[color];
    const isOutOfStock = title === "Itens Esgotados";
    const displayValue = value;
    const valueId = isOutOfStock ? 'id="kpi-out-of-stock"' : "";
    return `
      <div class="relative overflow-hidden rounded-3xl shadow-xl ${grad} text-white p-6 group transform transition-all duration-300 hover:-translate-y-1">
        <div class="absolute -right-6 -bottom-6 opacity-20 transform group-hover:scale-110 transition-transform duration-500">
          <i data-lucide="${icon}" class="w-32 h-32"></i>
        </div>
        <div class="relative z-10">
          <div class="flex items-center gap-3 mb-4 opacity-90"><div class="p-2 bg-white/20 rounded-xl backdrop-blur-sm"><i data-lucide="${icon}" class="w-5 h-5 text-white"></i></div><p class="text-xs font-bold uppercase tracking-wider">${title}</p></div>
          <h3 ${valueId} class="text-4xl font-extrabold tracking-tight">${displayValue}</h3>
        </div>
      </div>`;
  },
  renderChart() {
    if (this.depositsChartInstance) {
      this.depositsChartInstance.destroy();
    }
    if (this.monthlyChartInstance) {
      this.monthlyChartInstance.destroy();
    }
    if (this.statusChartInstance) {
      this.statusChartInstance.destroy();
    }

    const ctx = document.getElementById("depositsChart");
    const ctxMo = document.getElementById("monthlyChart");
    const ctxStatus = document.getElementById("statusChart");
    if (!ctx) return;

    const baseItems =
      this.dashboardCategory === "Todas"
        ? FirestoreService.items
        : FirestoreService.items.filter(
            (i) => i.categoria === this.dashboardCategory,
          );

    // --- CHART: Status do Estoque (Doughnut) ---
    if (ctxStatus) {
      let cNormal = 0,
        cAlerta = 0,
        cCritico = 0,
        cEsgotado = 0;
      baseItems.forEach((i) => {
        const est = Number(i.estoque) || 0;
        const min = Number(i.estoqueMinimo) || 0;
        if (est <= 0) cEsgotado++;
        else if (est <= min) cCritico++;
        else if (est <= min * 1.4) cAlerta++;
        else cNormal++;
      });
      this.statusChartInstance = new Chart(ctxStatus, {
        type: "doughnut",
        data: {
          labels: ["Normal", "Alerta", "Crítico", "Esgotado"],
          datasets: [
            {
              data: [cNormal, cAlerta, cCritico, cEsgotado],
              backgroundColor: ["#10b981", "#f59e0b", "#ef4444", "#64748b"],
              borderWidth: 0,
              hoverOffset: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "75%",
          plugins: {
            legend: {
              position: "right",
              labels: {
                usePointStyle: true,
                boxWidth: 8,
                font: { family: "Inter", size: 10 },
              },
            },
          },
        },
      });
    }

    // --- CHART: Bar (Categories OR Top Items) ---
    let dataMap = [];
    let barLabel = "";
    if (this.dashboardCategory === "Todas") {
      barLabel = "Volume em Estoque";
      const categories = [
        ...new Set(FirestoreService.items.map((i) => i.categoria)),
      ];
      dataMap = categories
        .map((cat) => {
          const itemsInCat = FirestoreService.items.filter(
            (i) => i.categoria === cat,
          );
          const sumEstoque = itemsInCat.reduce(
            (acc, i) => acc + (Number(i.estoque) || 0),
            0,
          );
          return {
            label: cat.replace(/DEPÓSITO |DEP\. /i, "").trim(),
            count: sumEstoque,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    } else {
      barLabel = "Volume (Un)";
      dataMap = baseItems
        .map((i) => ({
          label:
            i.descricao.length > 20
              ? i.descricao.substring(0, 20) + "..."
              : i.descricao,
          count: Number(i.estoque) || 0,
          fullDesc: i.descricao,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }

    this.depositsChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: dataMap.map((d) => d.label),
        datasets: [
          {
            label: barLabel,
            data: dataMap.map((d) => d.count),
            backgroundColor:
              this.dashboardCategory === "Todas" ? "#2563eb" : "#8b5cf6",
            hoverBackgroundColor:
              this.dashboardCategory === "Todas" ? "#1d4ed8" : "#7c3aed",
            borderRadius: 8,
            borderSkipped: false,
            barThickness: "flex",
            maxBarThickness: 45,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1e293b",
            padding: 14,
            titleFont: { size: 13, family: "Inter" },
            bodyFont: { size: 14, family: "Inter", weight: "bold" },
            displayColors: false,
            callbacks: {
              label: function (context) {
                const dataItem = dataMap[context.dataIndex];
                const title = dataItem.fullDesc
                  ? dataItem.fullDesc
                  : "Volume Total";
                return [`${title}: ${App.formatNumber(dataItem.count, 0)}`];
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: "#f1f5f9", drawBorder: false },
            border: { display: false },
            ticks: { font: { family: "Inter", size: 10 }, color: "#64748b" },
          },
          x: {
            grid: { display: false, drawBorder: false },
            border: { display: false },
            ticks: {
              font: { family: "Inter", size: 9 },
              color: "#64748b",
              maxRotation: 45,
              minRotation: 45,
            },
          },
        },
      },
    });

    if (ctxMo) {
      const monthNames = [
        "Jan",
        "Fev",
        "Mar",
        "Abr",
        "Mai",
        "Jun",
        "Jul",
        "Ago",
        "Set",
        "Out",
        "Nov",
        "Dez",
      ];
      const lastMonths = [];

      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        lastMonths.push({
          month: d.getMonth(),
          year: d.getFullYear(),
          label: `${monthNames[d.getMonth()]}/${d.getFullYear().toString().slice(-2)}`,
          in: 0,
          out: 0,
        });
      }

      const itemCatMap = {};
      FirestoreService.items.forEach((i) => (itemCatMap[i.id] = i.categoria));

      const baseMovements = (FirestoreService.movements || []).filter((m) =>
        this.dashboardCategory === "Todas"
          ? true
          : itemCatMap[m.itemId] === this.dashboardCategory,
      );

      baseMovements.forEach((mov) => {
        if (!mov.date || !mov.date.toDate) return;
        const d = mov.date.toDate();
        const target = lastMonths.find(
          (x) => x.month === d.getMonth() && x.year === d.getFullYear(),
        );
        if (target) {
          if (mov.type === "entrada") target.in += Number(mov.qty) || 0;
          if (mov.type === "saida") target.out += Number(mov.qty) || 0;
        }
      });

      // IA: Regressão Linear Simples para Projetar Próximo Mês
      let sumX = 0,
        sumY = 0,
        sumXY = 0,
        sumXX = 0;
      const n = 6;
      lastMonths.forEach((m, idx) => {
        sumX += idx;
        sumY += m.out;
        sumXY += idx * m.out;
        sumXX += idx * idx;
      });
      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      const nextMonthOut = Math.max(0, Math.round(slope * 6 + intercept)); // Próximo índice é 6

      const nextDate = new Date();
      nextDate.setMonth(nextDate.getMonth() + 1);
      const nextLabel = `Prev. ${monthNames[nextDate.getMonth()]}`;

      const labels = [...lastMonths.map((m) => m.label), nextLabel];
      const dataIn = [...lastMonths.map((m) => m.in), null];
      const dataOut = [...lastMonths.map((m) => m.out), null];
      const dataPred = [
        null,
        null,
        null,
        null,
        null,
        lastMonths[5].out,
        nextMonthOut,
      ];

      this.monthlyChartInstance = new Chart(ctxMo, {
        type: "line",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Entradas",
              data: dataIn,
              borderColor: "#10b981",
              backgroundColor: "#10b98120",
              fill: true,
              tension: 0.4,
              borderWidth: 2,
              pointBackgroundColor: "#10b981",
              pointRadius: 0,
            },
            {
              label: "Saídas Realizadas",
              data: dataOut,
              borderColor: "#f43f5e",
              backgroundColor: "#f43f5e20",
              fill: true,
              tension: 0.4,
              borderWidth: 2,
              pointBackgroundColor: "#f43f5e",
              pointRadius: 0,
            },
            {
              label: "Previsão IA (Próx Mês)",
              data: dataPred,
              borderColor: "#8b5cf6",
              backgroundColor: "transparent",
              borderDash: [5, 5],
              fill: false,
              tension: 0.4,
              borderWidth: 2,
              pointBackgroundColor: "#8b5cf6",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "top",
              labels: { usePointStyle: true, font: { family: "Inter" } },
            },
            tooltip: {
              backgroundColor: "#1e293b",
              padding: 14,
              titleFont: { size: 13, family: "Inter" },
              bodyFont: { size: 14, family: "Inter", weight: "bold" },
              displayColors: true,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: "#f1f5f9", drawBorder: false },
              border: { display: false },
              ticks: { font: { family: "Inter" }, color: "#64748b" },
            },
            x: {
              grid: { display: false, drawBorder: false },
              border: { display: false },
              ticks: { font: { family: "Inter" }, color: "#64748b" },
            },
          },
        },
      });
    }
  },
  renderMovementsLayout(title) {
    const container = document.getElementById("content-area");
    if (!AuthService.getCurrentUser()) return;

    let depositsList = (FirestoreService.deposits || [])
      .map((d) => (d?.name ?? d?.categoria ?? d?.id ?? "").toString().trim())
      .filter(Boolean);

    if (depositsList.length === 0) {
      depositsList = [
        ...new Set(FirestoreService.items.map((i) => i.categoria)),
      ]
        .filter(Boolean)
        .map((c) => c.toString().trim());
    }

    const deposits = [...new Set(depositsList)]
      .filter((s) => s.toUpperCase() !== "DEPÓSITO GERAL")
      .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
    const categories = ["Todas", ...deposits];

    if (!title) title = "Movimentação de Estoque";
    const actionsHeader = '<th class="px-4 py-4 text-right w-72">Ações</th>';
    container.innerHTML = `
      <div class="space-y-4 h-full flex flex-col animate-fade-in max-w-[1600px] mx-auto pt-2">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-3xl border border-slate-200/60 shadow-sm z-10">
          <div class="flex flex-col sm:flex-row gap-3">
            <div class="relative group"><i data-lucide="search" class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-brand-500 transition-colors"></i><input type="text" placeholder="Buscar código, nome..." value="${InventoryController.state.searchTerm}" oninput="InventoryController.handleSearch(this.value)" class="w-full sm:w-72 pl-10 pr-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 text-sm bg-slate-50 focus:bg-white transition-all shadow-sm"></div>
            <div class="relative">
              <select id="filter-categoria" onchange="InventoryController.handleCategory(this.value)" class="appearance-none w-full sm:w-64 bg-white border border-slate-300 text-slate-700 py-2.5 pl-4 pr-10 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm cursor-pointer shadow-sm hover:border-brand-400 transition-colors">
                ${categories.map((cat) => `<option value="${cat}" ${InventoryController.state.categoryFilter === cat ? "selected" : ""}>${cat}</option>`).join("")}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-lucide="chevron-down" aria-hidden="true" class="lucide lucide-chevron-down w-4 h-4"><path d="m6 9 6 6 6-6"></path></svg></div>
            </div>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl shadow-none md:shadow-sm border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col">
          <div class="overflow-auto flex-1 custom-scrollbar"><table class="block md:table w-full text-sm text-left relative"><thead class="hidden md:table-header-group bg-slate-50/80 text-slate-500 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-20 backdrop-blur-md border-b border-slate-200/80"><tr><th class="px-4 py-4 w-28">Código</th><th class="px-4 py-4 w-24">Cód. Int.</th><th class="px-4 py-4 min-w-[200px]">Descrição</th><th class="px-4 py-4 text-center w-20">Unid.</th><th class="px-4 py-4 text-center w-24">Saldo</th><th class="px-4 py-4 text-center w-20">Mín.</th><th class="px-4 py-4 text-center w-20">Ressup.</th><th class="px-4 py-4 text-center w-24">Status</th>${actionsHeader}</tr></thead><tbody id="inventory-body" class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 space-y-4 md:space-y-0"></tbody></table></div>
          <div class="bg-white md:bg-slate-50 px-4 py-3 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3 mt-2 md:mt-0 shadow-sm md:shadow-none">
            <div class="text-xs text-slate-500">Total: <span id="total-records" class="font-bold">0</span> <span class="mx-2">•</span> Página <span id="current-page" class="font-bold text-slate-700">1</span> de <span id="total-pages" class="font-bold text-slate-700">1</span></div>
            <div class="flex items-center gap-2">
              <button id="btn-prev-page" onclick="InventoryController.changePage(-1)" class="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
              <button id="btn-next-page" onclick="InventoryController.changePage(1)" class="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
            </div>
          </div>
        </div>
      </div>`;
    this.renderTableRows();
  },
  renderTableRows() {
    const tbody = document.getElementById("inventory-body");
    if (!tbody) return;
    const { searchTerm, searchName, searchCode, categoryFilter, statusFilter } =
      InventoryController.state;
    const items = FirestoreService.items;
    const isMovementTab = this.currentTab === "stock-move";
    const isStockSearchTab = this.currentTab === "stock-search";
    const normalizeText = (text) =>
      text != null
        ? String(text)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
        : "";
    const searchNormalized = normalizeText(searchTerm);
    const searchNameNormalized = normalizeText(searchName);
    const searchCodeNormalized = normalizeText(searchCode);
    const getStatus = (item) => {
      const estoque = Number(item?.estoque) || 0;
      const min = Number(item?.estoqueMinimo) || 0;
      const alertThreshold = min * 1.4;
      if (estoque <= 0) return "Esgotado";
      if (estoque <= min) return "Critico";
      if (estoque <= alertThreshold) return "Alerta";
      return "Normal";
    };
    const filtered = items.filter((item) => {
      const descNormalized = normalizeText(item.descricao);
      const codeNormalized = normalizeText(item.codigo);
      const internalCodeNormalized = normalizeText(item.codigoInterno);

      let matchesSearch = true;
      if (isMovementTab) {
        if (searchNormalized) {
          matchesSearch =
            descNormalized.includes(searchNormalized) ||
            codeNormalized.includes(searchNormalized) ||
            internalCodeNormalized.includes(searchNormalized);
        }
      } else if (isStockSearchTab) {
        const matchesName =
          !searchNameNormalized ||
          descNormalized.includes(searchNameNormalized);
        const matchesCode =
          !searchCodeNormalized ||
          codeNormalized.includes(searchCodeNormalized) ||
          internalCodeNormalized.includes(searchCodeNormalized);
        matchesSearch = matchesName && matchesCode;
      }

      const safeCat = (item.categoria || "").toString().trim().toUpperCase();
      const safeFilter = (categoryFilter || "Todas")
        .toString()
        .trim()
        .toUpperCase();
      const matchesCategory = safeFilter === "TODAS" || safeCat === safeFilter;

      const matchesStatus =
        !isStockSearchTab ||
        statusFilter === "Todos" ||
        getStatus(item) === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });

    const uniqueItems = [];
    const seenKeys = new Set();
    filtered.forEach((item) => {
      let key = "";
      const codigo = item.codigo ? String(item.codigo).trim() : "";
      const descricao = item.descricao ? String(item.descricao).trim() : "";
      if (codigo.length > 3 && !codigo.includes("****")) {
        key = "CODE:" + codigo.toUpperCase();
      } else {
        key = descricao ? "DESC:" + descricao.toUpperCase() : "ID:" + item.id;
      }
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueItems.push(item);
      }
    });

    InventoryController.state.currentExportData = uniqueItems;

    // --- Paginação ---
    const totalItems = uniqueItems.length;
    const itemsPerPage = InventoryController.state.itemsPerPage;
    const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

    if (InventoryController.state.currentPage > totalPages) {
      InventoryController.state.currentPage = totalPages;
    }
    if (InventoryController.state.currentPage < 1) {
      InventoryController.state.currentPage = 1;
    }

    const startIdx = (InventoryController.state.currentPage - 1) * itemsPerPage;
    const endIdx = startIdx + itemsPerPage;
    const paginatedItems = uniqueItems.slice(startIdx, endIdx);

    const colSpan = 9;
    if (paginatedItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${colSpan}" class="px-6 py-20 text-center flex flex-col items-center justify-center text-slate-400"><div class="bg-slate-50 p-4 rounded-full mb-3"><i data-lucide="search-x" class="w-8 h-8"></i></div><span class="font-medium">Nenhum item encontrado</span><span class="text-xs mt-1">Tente ajustar os filtros de busca</span></td></tr>`;
    } else {
      tbody.innerHTML = paginatedItems
        .map((item, index) => {
          const min = Number(item.estoqueMinimo) || 0;
          const estoque = Number(item.estoque) || 0;
          const status = getStatus(item);
          let statusHtml = "";
          let rowClass =
            "block md:table-row bg-white md:bg-transparent border md:border-y-0 md:border-r-0 md:border-l-4 border-slate-200 md:border-l-transparent rounded-2xl md:rounded-none shadow-sm md:shadow-none p-4 md:p-0 hover:bg-slate-50/80 hover:shadow-lg hover:shadow-slate-200/40 hover:relative hover:z-10 transition-all duration-300 group animate-fade-in opacity-0 mb-3 md:mb-0";
          if (status === "Esgotado") {
            statusHtml =
              '<span class="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 ring-1 ring-slate-200/60">Esgotado</span>';
            rowClass += " hover:border-slate-400 md:hover:border-l-slate-400";
          } else if (status === "Critico") {
            statusHtml =
              '<span class="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-100 ring-1 ring-red-500/10">Crítico</span>';
            rowClass += " hover:border-red-500 md:hover:border-l-red-500";
          } else if (status === "Alerta") {
            statusHtml =
              '<span class="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 ring-1 ring-amber-500/20">Alerta</span>';
            rowClass += " hover:border-amber-500 md:hover:border-l-amber-500";
          } else {
            statusHtml =
              '<span class="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 ring-1 ring-emerald-500/20">Normal</span>';
            rowClass +=
              " hover:border-emerald-500 md:hover:border-l-emerald-500";
          }
          let actionsCell = "";
          if (isMovementTab) {
            actionsCell = `<td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 text-center md:text-right mt-2 md:mt-0 border-t border-slate-100 md:border-none"><div class="flex flex-wrap md:flex-nowrap items-center justify-center md:justify-end gap-2 w-full"><button onclick="InventoryController.openMovementModal('${item.id}', 'entrada')" class="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-100 hover:bg-emerald-200 border border-emerald-200/60 rounded-xl transition-all shadow-sm active:scale-95" title="Registrar Entrada"><i data-lucide="arrow-down-to-line" class="w-3.5 h-3.5"></i> Entrada</button><button onclick="InventoryController.openMovementModal('${item.id}', 'saida')" class="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 text-[11px] font-bold uppercase tracking-wider text-rose-700 bg-rose-100 hover:bg-rose-200 border border-rose-200/60 rounded-xl transition-all shadow-sm active:scale-95" title="Registrar Saída"><i data-lucide="arrow-up-from-line" class="w-3.5 h-3.5"></i> Saída</button></div></td>`;
          } else {
            actionsCell = `<td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 text-center md:text-right mt-2 md:mt-0 border-t border-slate-100 md:border-none"><div class="flex items-center justify-center md:justify-end gap-2 md:opacity-80 group-hover:opacity-100 transition-opacity w-full"><button onclick="InventoryController.openStockDetailModal('${item.id}')" class="w-full md:w-auto flex justify-center items-center gap-2 p-2.5 md:p-1.5 text-brand-600 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-xl md:rounded-lg transition-all shadow-sm hover:shadow active:scale-95" title="Ver Detalhes"><i data-lucide="eye" class="w-4 h-4 md:w-3.5 md:h-3.5"></i><span class="md:hidden text-xs font-bold uppercase tracking-wider">Ver Detalhes</span></button></div></td>`;
          }
          const catRaw = (item.categoria || "").toString();
          const catShort = catRaw
            ? catRaw.replace(/DEPÓSITO |DEP\. /, "")
            : "-";
          const estoqueClass =
            status === "Esgotado"
              ? "text-slate-500"
              : status === "Critico"
                ? "text-red-600"
                : status === "Alerta"
                  ? "text-amber-600"
                  : "text-slate-700";
          return `<tr class="${rowClass}" style="animation-delay: ${Math.min(index * 30, 400)}ms;">
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Código</span><span class="font-mono text-xs text-slate-500">${Utils.escapeHTML(item.codigo)}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Cód. Int.</span><span class="font-mono text-xs text-slate-500">${Utils.escapeHTML(item.codigoInterno || "-")}</span></td>
            <td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><div class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider mb-1">Descrição</div><div class="font-semibold text-slate-800 text-sm mb-0.5">${Utils.escapeHTML(item.descricao)}</div><div class="text-[10px] text-slate-400 uppercase tracking-wide truncate max-w-full md:max-w-[200px]" title="${Utils.escapeHTML(catRaw || "-")}">${Utils.escapeHTML(catShort)}</div></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-center"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Unidade</span><span class="text-xs text-slate-500">${Utils.escapeHTML(item.unidade || item.unidadeEntrada || "-")}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-center"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Saldo</span><span class="font-mono text-base font-bold ${estoqueClass}">${estoque}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-center"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Mínimo</span><span class="font-mono text-xs text-slate-500">${min}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-center"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Ressup.</span><span class="font-mono text-xs text-slate-500">${item.qtdRessuprimento || "-"}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-3 md:px-4 md:py-4 border-none md:border-none text-left md:text-center"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Status</span>${statusHtml}</td>
            ${actionsCell}
          </tr>`.replace(/\n\s*/g, "");
        })
        .join("");
    }

    const counter = document.getElementById("total-records");
    if (counter) counter.innerText = totalItems;
    const pageSpan = document.getElementById("current-page");
    if (pageSpan) pageSpan.innerText = InventoryController.state.currentPage;
    const totalPagesSpan = document.getElementById("total-pages");
    if (totalPagesSpan) totalPagesSpan.innerText = totalPages;
    const btnPrev = document.getElementById("btn-prev-page");
    if (btnPrev) btnPrev.disabled = InventoryController.state.currentPage === 1;
    const btnNext = document.getElementById("btn-next-page");
    if (btnNext)
      btnNext.disabled = InventoryController.state.currentPage === totalPages;

    lucide.createIcons();
  },
  async handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const btn = event.target.parentElement;

    const originalHTML = btn.innerHTML;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split("\n");
      const newItems = [];
      let currentCategory = "Importado";
      if (file.name.includes("DEP.")) {
        const parts = file.name.split(".");
        if (parts.length > 1) currentCategory = parts[0] + " " + parts[1];
      }
      lines.forEach((line, index) => {
        if (line.length < 10 || line.includes("CÓDIGO DO CONTRATO")) return;
        const cols = line.split(",");
        const codigo = cols.find((c) => c && c.match(/B\.\d{2}\.\d{2}\.\d{3}/));
        if (codigo) {
          const descIndex = cols.findIndex(
            (c) => c.length > 10 && !c.match(/B\.\d{2}/),
          );
          const descricao =
            cols[descIndex]?.replace(/"/g, "") || "Item importado";
          const numbers = cols
            .map((c) => parseFloat(c))
            .filter((n) => !isNaN(n));
          let codigoInterno = "";
          for (let i = 0; i < cols.length; i++) {
            const val = cols[i].trim();
            if (!isNaN(val) && val.length >= 4 && val !== codigo) {
              codigoInterno = val;
              break;
            }
          }
          const estoque = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
          const estoqueMinimo = 10;
          newItems.push({
            id: Date.now() + index + Math.random(),
            codigo: codigo,
            codigoInterno: codigoInterno,
            descricao: descricao,
            categoria: currentCategory,
            unidade: "UN",
            estoque: estoque,
            estoqueMinimo: estoqueMinimo,
            qtdRessuprimento: estoqueMinimo * 2,
          });
        }
      });
      if (newItems.length > 0) {
        btn.innerHTML = `<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i> Processando...`;
        lucide.createIcons();

        FirestoreService.importItems(newItems)
          .then(() => {
            ToastManager.show(
              `${newItems.length} itens importados para o Firebase!`,
              "success",
            );
            if (App.currentTab === "dashboard") App.renderDashboard();
            else App.renderMovementsLayout();
          })
          .catch((err) => {
            if (err.message === "permission-denied") {
              ToastManager.show("Sem permissão para importar dados.", "error");
            } else {
              ToastManager.show("Erro ao importar CSV.", "error");
            }
          })
          .finally(() => {
            btn.innerHTML = originalHTML;
            lucide.createIcons();
          });
      } else {
        ToastManager.show("Formato de arquivo inválido ou sem dados.", "error");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  },
  renderHistoryLayout() {
    const container = document.getElementById("content-area");
    const uniqueUsers = [
      ...new Set(
        (FirestoreService.movements || [])
          .map((m) => m.userName)
          .filter(Boolean),
      ),
    ].sort();

    container.innerHTML = `
      <div class="space-y-4 h-full flex flex-col animate-fade-in max-w-7xl mx-auto pt-2">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-3xl border border-slate-200/60 shadow-sm z-10">
          <div class="flex flex-col sm:flex-row gap-3 w-full">
            <div class="relative group flex-1"><i data-lucide="search" class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-brand-500 transition-colors"></i><input type="text" id="search-history" placeholder="Buscar material, código..." oninput="App.renderHistoryTableRows()" class="w-full pl-10 pr-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 text-sm bg-slate-50 focus:bg-white transition-all shadow-sm"></div>
            <div class="relative">
              <select id="filter-user-history" onchange="App.renderHistoryTableRows()" class="appearance-none w-full sm:w-56 bg-slate-50 border-0 ring-1 ring-slate-200 focus:bg-white text-slate-700 py-3 pl-4 pr-10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer shadow-sm transition-all">
                <option value="">Todos os Usuários</option>
                ${uniqueUsers.map((u) => `<option value="${Utils.escapeHTML(u)}">${Utils.escapeHTML(u)}</option>`).join("")}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="m6 9 6 6 6-6"></path></svg></div>
            </div>
            <button onclick="App.exportHistoryToPDF()" class="w-full sm:w-auto px-5 py-3 bg-red-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-red-700 transition-all flex items-center justify-center gap-2 active:scale-95 shrink-0"><i data-lucide="file-text" class="w-4 h-4"></i> Exportar PDF</button>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl shadow-none md:shadow-sm border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col">
          <div class="overflow-auto flex-1 custom-scrollbar">
            <table class="block md:table w-full text-sm text-left relative">
              <thead class="hidden md:table-header-group bg-slate-50/80 text-slate-500 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-20 backdrop-blur-md border-b border-slate-200/80">
                <tr><th class="px-4 py-4 w-40">Data/Hora</th><th class="px-4 py-4 w-48">Usuário</th><th class="px-4 py-4 min-w-[200px]">Material</th><th class="px-4 py-4 text-center w-20">Tipo</th><th class="px-4 py-4 text-right w-20">Qtd</th><th class="px-4 py-4 text-right w-24">Saldo Ant.</th><th class="px-4 py-4 text-right w-24">Novo Saldo</th></tr>
              </thead>
              <tbody id="history-body" class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 bg-transparent md:bg-white space-y-4 md:space-y-0"></tbody>
            </table>
          </div>
        </div>
      </div>`;
    lucide.createIcons();
    this.renderHistoryTableRows();
  },
  renderHistoryTableRows() {
    const tbody = document.getElementById("history-body");
    if (!tbody) return;
    const searchInput = document.getElementById("search-history");
    const userFilter =
      document.getElementById("filter-user-history")?.value || "";
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : "";
    const filtered = (FirestoreService.movements || []).filter((mov) => {
      const desc = (mov.itemDesc || "").toLowerCase();
      const user = (mov.userName || "").toLowerCase();
      const code = (mov.itemCodigo || "").toLowerCase();
      const matchesSearch =
        desc.includes(searchTerm) ||
        user.includes(searchTerm) ||
        code.includes(searchTerm) ||
        (mov.itemCodigoInterno || "").toLowerCase().includes(searchTerm);
      const matchesUser = !userFilter || mov.userName === userFilter;
      return matchesSearch && matchesUser;
    });
    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="px-6 py-20 text-center text-slate-400">Nenhuma movimentação encontrada.</td></tr>';
      return;
    }
    tbody.innerHTML = filtered
      .map((mov, index) => {
        const dateStr =
          mov.date && mov.date.toDate
            ? mov.date.toDate().toLocaleString("pt-BR")
            : "Data Indisponível";
        const typeHtml =
          mov.type === "entrada"
            ? '<span class="inline-flex items-center px-2 py-1 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase">Entrada</span>'
            : '<span class="inline-flex items-center px-2 py-1 rounded-md text-[10px] font-bold bg-red-50 text-red-700 border border-red-200 uppercase">Saída</span>';
        const reasonHtml = mov.reason
          ? `<div class="text-[10px] text-slate-500 mt-1.5 leading-tight"><strong class="text-slate-600">Motivo:</strong> ${Utils.escapeHTML(mov.reason)}</div>`
          : "";
        const intCodeHtml = mov.itemCodigoInterno
          ? `<span class="px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-[9px] ml-2 text-slate-500" title="Cód. Interno">Int: ${Utils.escapeHTML(mov.itemCodigoInterno)}</span>`
          : "";
        const qtyColor =
          mov.type === "entrada" ? "text-emerald-600" : "text-red-600";
        const qtySign = mov.type === "entrada" ? "+" : "-";
        return `<tr class="hover:bg-slate-50/80 hover:shadow-lg hover:shadow-slate-200/40 hover:relative hover:z-10 transition-all duration-300 group block md:table-row bg-white md:bg-transparent border md:border-y-0 md:border-r-0 md:border-l-4 border-slate-200 md:border-l-transparent rounded-2xl md:rounded-none shadow-sm md:shadow-none p-4 md:p-0 mb-3 md:mb-0 animate-fade-in opacity-0" style="animation-delay: ${index * 30}ms;">
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none font-mono text-xs text-slate-500 align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Data/Hora</span><span>${dateStr}</span></td>
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-xs font-medium text-slate-700 align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Usuário</span><span>${Utils.escapeHTML(mov.userName || "-")}</span></td>
          <td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 border-b border-slate-100 md:border-none align-top"><div class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider mb-1">Material</div><div class="font-semibold text-slate-800 text-sm">${Utils.escapeHTML(mov.itemDesc)}</div><div class="text-[10px] text-slate-400 font-mono mt-0.5">${Utils.escapeHTML(mov.itemCodigo)}${intCodeHtml}</div>${reasonHtml}</td>
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-center align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Tipo</span>${typeHtml}</td>
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-right font-mono font-bold ${qtyColor} align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Qtd</span><span>${qtySign}${mov.qty}</span></td>
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none text-left md:text-right font-mono text-slate-500 align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Saldo Ant.</span><span>${mov.previousStock !== undefined ? mov.previousStock : "-"}</span></td>
          <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-none text-left md:text-right font-mono font-bold text-slate-900 align-top"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Novo Saldo</span><span>${mov.newStock !== undefined ? mov.newStock : "-"}</span></td>
        </tr>`.replace(/\n\s*/g, "");
      })
      .join("");
  },
  exportHistoryToPDF() {
    if (!window.jspdf)
      return ToastManager.show("Módulo PDF carregando...", "warning");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("landscape");

    const searchInput =
      document.getElementById("search-history")?.value.toLowerCase() || "";
    const userFilter =
      document.getElementById("filter-user-history")?.value || "";

    const filtered = (FirestoreService.movements || []).filter((mov) => {
      const matchStr = (
        (mov.itemDesc || "") +
        (mov.itemCodigo || "") +
        (mov.userName || "")
      ).toLowerCase();
      const matchS = matchStr.includes(searchInput);
      const matchU = !userFilter || mov.userName === userFilter;
      return matchS && matchU;
    });

    if (filtered.length === 0)
      return ToastManager.show("Não há dados para exportar.", "warning");

    doc.setFontSize(14);
    doc.text("Relatório de Movimentações (Log de Usuários) - SEROB", 14, 15);
    doc.setFontSize(10);
    doc.text(`Emitido em: ${new Date().toLocaleString("pt-BR")}`, 14, 22);

    const tableData = filtered.map((mov) => [
      mov.date?.toDate ? mov.date.toDate().toLocaleString("pt-BR") : "-",
      mov.userName || "-",
      mov.itemCodigo || "-",
      mov.itemDesc || "-",
      mov.type === "entrada" ? "Entrada" : "Saída",
      mov.qty || 0,
      mov.reason || "-",
    ]);

    doc.autoTable({
      startY: 28,
      head: [
        [
          "Data/Hora",
          "Usuário Logado",
          "Código",
          "Material",
          "Tipo",
          "Qtd",
          "Motivo",
        ],
      ],
      body: tableData,
      theme: "striped",
      styles: { fontSize: 8 },
      headStyles: { fillColor: [37, 99, 235] }, // Azul brand-600
    });

    doc.save(`auditoria_movimentacoes_${new Date().getTime()}.pdf`);
    ToastManager.show("Relatório PDF gerado com sucesso!", "success");
  },
  renderRegisterLayout() {
    const container = document.getElementById("content-area");
    container.innerHTML = `
      <div class="max-w-3xl mx-auto animate-fade-in pt-4">
        <div class="bg-white rounded-3xl shadow-lg shadow-slate-200/40 border border-slate-200/60 p-8 md:p-10 relative overflow-hidden">
          <div class="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-brand-500 to-indigo-500"></div>
          <form onsubmit="InventoryController.saveNewItem(event)" class="space-y-5">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
<div>
  <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Descrição do Material</label>
  <input type="text" id="new-descricao" list="lista-descricoes" onchange="InventoryController.handleDescricaoAutoFill()" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" placeholder="Nome completo do item" required />
  <datalist id="lista-descricoes">
    ${[...new Set((FirestoreService.items || []).map((i) => i.descricao).filter(Boolean))].map((desc) => `<option value="${Utils.escapeHTML(desc)}"></option>`).join("")}
  </datalist>
</div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Cód. Interno</label><input type="text" id="new-codigo-interno" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm font-mono text-sm" placeholder="Ex: 12345" required oninput="InventoryController.handleCodigoInternoAutoFill()" /></div>
            </div>
            <div class="grid grid-cols-2 gap-6">
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Categoria</label><select id="new-categoria" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" required></select></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Unidade</label><input type="text" id="new-unidade" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" placeholder="Ex: Unidade" required /></div>
            </div>
            <div class="grid grid-cols-3 gap-6 border-t border-slate-100 pt-6 mt-2">
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Estoque Inicial</label><input type="number" id="new-estoque" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="0" /></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Mínimo</label><input type="number" id="new-minimo" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="5" /></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Ressuprimento</label><input type="number" id="new-ressup" class="w-full px-4 py-3.5 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="10" /></div>
            </div>
            <div class="flex justify-end pt-6"><button type="submit" class="px-8 py-4 bg-brand-600 text-white font-bold rounded-2xl shadow-lg shadow-brand-600/30 hover:bg-brand-700 transition-all transform active:scale-95 flex items-center gap-2"><i data-lucide="check" class="w-5 h-5"></i> Salvar Material</button></div>
          </form>
        </div>
      </div>`;
    lucide.createIcons();
    this.renderDepositOptions();
  },
  viewTenantDetails() {
    const tenantName = FirestoreService.profile?.tenantName || "COENG | DETEC";
    const totalItems = FirestoreService.items.length;
    const totalMovs = FirestoreService.movements.length;
    const alertMsg =
      `🏢 Resumo do Cliente (Tenant)\n\n` +
      `Nome da Empresa: ${tenantName}\n` +
      `Plano Assinado: Pro SaaS\n` +
      `Valor da Assinatura: R$ 97,00/mês\n` +
      `Status da Conta: Ativa e Adimplente\n\n` +
      `📊 Uso do Banco de Dados:\n` +
      `- Itens no Estoque: ${totalItems}\n` +
      `- Movimentações Registradas: ${totalMovs}`;
    alert(alertMsg);
  },
  renderSaaSAdmin() {
    const container = document.getElementById("content-area");
    container.innerHTML = `
      <div class="space-y-6 animate-fade-in max-w-7xl mx-auto pt-4">
        <div class="bg-gradient-to-r from-slate-900 to-slate-800 rounded-3xl p-8 shadow-xl text-white relative overflow-hidden">
           <div class="absolute top-0 right-0 opacity-10 pointer-events-none transform translate-x-1/4 -translate-y-1/4"><i data-lucide="shield-check" class="w-64 h-64"></i></div>
           <div class="relative z-10">
              <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold uppercase tracking-wider mb-4 border border-purple-500/30"><i data-lucide="crown" class="w-3.5 h-3.5"></i> Super Admin</div>
              <h2 class="text-3xl font-extrabold tracking-tight mb-2">Painel de Gestão Multiempresa</h2>
              <p class="text-slate-400">Controle total sobre faturamento, empresas clientes e métricas globais do SaaS.</p>
           </div>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
           <div class="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60">
              <div class="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4"><i data-lucide="building-2" class="w-5 h-5"></i></div>
              <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Empresas Ativas</p>
              <h3 class="text-4xl font-extrabold text-slate-800">1</h3>
           </div>
           <div class="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60">
              <div class="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-4"><i data-lucide="users" class="w-5 h-5"></i></div>
              <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Usuários Registrados</p>
              <h3 class="text-4xl font-extrabold text-slate-800">3</h3>
           </div>
           <div class="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60">
              <div class="w-10 h-10 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center mb-4"><i data-lucide="credit-card" class="w-5 h-5"></i></div>
              <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">MRR (Faturamento Mock)</p>
              <h3 class="text-4xl font-extrabold text-slate-800">R$ 97<span class="text-base text-slate-400 font-medium">/mês</span></h3>
           </div>
        </div>
        
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden mt-6">
           <div class="p-6 border-b border-slate-100"><h3 class="font-bold text-slate-800">Clientes (Tenants)</h3></div>
           <table class="w-full text-left text-sm">
             <thead class="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-wider"><tr><th class="px-6 py-4">Empresa</th><th class="px-6 py-4">Plano</th><th class="px-6 py-4 text-center">Status</th><th class="px-6 py-4 text-right">Ação</th></tr></thead>
             <tbody class="divide-y divide-slate-100">
                <tr class="hover:bg-slate-50"><td class="px-6 py-4 font-semibold text-slate-800">${FirestoreService.profile.tenantName || "COENG | DETEC"}</td><td class="px-6 py-4 text-slate-500">Pro SaaS</td><td class="px-6 py-4 text-center"><span class="px-2 py-1 rounded bg-emerald-100 text-emerald-700 text-xs font-bold">Ativo</span></td><td class="px-6 py-4 text-right"><button onclick="App.viewTenantDetails()" class="text-brand-600 font-bold text-xs hover:underline">Ver Detalhes</button></td></tr>
             </tbody>
           </table>
        </div>
      </div>`;
    lucide.createIcons();
  },
};

// --- Main Exports (Expose to Window) ---
window.App = App;
window.AuthController = AuthController;
window.InventoryController = InventoryController;
window.ModalManager = ModalManager;
window.FirestoreService = FirestoreService;

// --- Bootstrap ---
document.addEventListener("DOMContentLoaded", () => App.init());
