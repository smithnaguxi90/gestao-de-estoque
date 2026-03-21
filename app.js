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
              const registerLayout = document.getElementById("register-layout");
              if (registerLayout) {
                registerLayout.classList.add("hidden");
                registerLayout.classList.remove("flex");
              }
              const landingLayout = document.getElementById("landing-layout");
              if (landingLayout) landingLayout.classList.remove("hidden");
            }
            
            if (window.App && typeof window.App.updateLandingUI === "function") {
              window.App.updateLandingUI();
            }
          } catch (err) {
            console.error("Falha no handler de auth:", err);
            if (err.message === "ACCOUNT_DISABLED") {
              try {
                ToastManager?.show?.(
                  "Sua conta foi desativada pelo administrador.",
                  "error",
                );
              } catch {}
              AuthService.logout();
            }
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
        plan: "enterprise",
      },
      "jesse.anjos@camara.leg.br": {
        name: "Jessé",
        role: "user",
        label: "Usuário",
        plan: "enterprise",
      },
      "jefferson.araujo@camara.leg.br": {
        name: "Jefferson",
        role: "admin",
        label: "Administrador",
        plan: "enterprise",
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
    const desiredPlan = preset?.plan || "starter";

    this.profile = this.profile || {
      uid,
      name: desiredName,
      label: desiredLabel,
      role: desiredRole,
      plan: desiredPlan,
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
        plan: desiredPlan,
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
      if (data.active === false) {
        throw new Error("ACCOUNT_DISABLED");
      }
      const patch = {};
      if (!data.uid) patch.uid = uid;
      if (!data.email && user.email) patch.email = user.email;
      if (!data.name) patch.name = desiredName;
      if (!data.role && desiredRole) patch.role = desiredRole;
      if (!data.plan) patch.plan = desiredPlan;
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

  async toggleFavorite(itemId) {
    const u = auth.currentUser;
    if (!u || !this.profile) return;

    let favs = this.profile.favorites || [];
    const strId = String(itemId);
    if (favs.includes(strId)) {
      favs = favs.filter((id) => id !== strId);
    } else {
      favs.push(strId);
    }
    this.profile.favorites = favs;

    try {
      await setDoc(
        doc(db, "users", u.uid),
        { favorites: favs },
        { merge: true },
      );
      if (window.App && typeof window.App.refreshUI === "function")
        window.App.refreshUI();
    } catch (e) {
      console.error("Erro ao favoritar:", e);
    }
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

  async handleRegister(e) {
    e.preventDefault();
    const email = document.getElementById("register-username").value;
    const pass = document.getElementById("register-password").value;
    const name = document.getElementById("register-name")?.value || "";
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i>`;
    lucide.createIcons();
    btn.disabled = true;

    // Verificação de Força da Senha (Letras, Números e min 6 caracteres)
    const passwordRegex = /^(?=.*[a-zA-Z])(?=.*\d).{6,}$/;
    if (!passwordRegex.test(pass)) {
      const errEl = document.getElementById("register-error");
      if (errEl) {
        errEl.querySelector("span").textContent =
          "A senha deve conter letras, números e no mínimo 6 caracteres.";
        errEl.classList.remove("hidden");
        errEl.classList.add("flex");
        setTimeout(() => errEl.classList.add("hidden"), 5000);
      }
      btn.innerHTML = originalText;
      btn.disabled = false;
      lucide.createIcons();
      return;
    }

    try {
      const userCred = await createUserWithEmailAndPassword(auth, email, pass);
      if (name) {
        // Pré-salva o nome escolhido no perfil do usuário no Firestore
        await setDoc(
          doc(db, "users", userCred.user.uid),
          { name: name },
          { merge: true },
        );
      }
      const errEl = document.getElementById("register-error");
      errEl?.classList.add("hidden");
    } catch (err) {
      console.error(err);
      const errEl = document.getElementById("register-error");
      let msg = "Erro ao criar conta. Tente novamente.";
      if (err.code === "auth/email-already-in-use")
        msg = "Este email já está em uso.";
      else if (err.code === "auth/weak-password")
        msg = "A senha deve ter pelo menos 6 caracteres.";
      else if (err.code === "auth/invalid-email") msg = "Email inválido.";

      if (errEl) {
        errEl.querySelector("span").textContent = msg;
        errEl.classList.remove("hidden");
        errEl.classList.add("flex");
        setTimeout(() => errEl.classList.add("hidden"), 4000);
      }
      btn.innerHTML = originalText;
      btn.disabled = false;
      lucide.createIcons();
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

    try {
      const collectionsToClear = ["items", "movements"];
      for (const colName of collectionsToClear) {
        const snap = await getDocs(collection(db, colName));
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += 500) {
          const chunk = docs.slice(i, i + 500);
          const batch = writeBatch(db);
          chunk.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
    } catch (e) {
      console.error("Erro ao resetar dados", e);
    }

    localStorage.removeItem("serob_db_items");
    location.reload();
  },

  async updateItem(id, updates) {
    if (!AuthService.isAdmin()) throw new Error("permission-denied");
    try {
      const docRef = doc(db, "items", String(id));
      await updateDoc(docRef, updates);
      return true;
    } catch (e) {
      console.error("Erro ao atualizar item:", e);
      return false;
    }
  },

  async deleteItem(id) {
    if (!AuthService.isAdmin()) throw new Error("permission-denied");
    try {
      const docRef = doc(db, "items", String(id));
      await deleteDoc(docRef);
      return true;
    } catch (e) {
      console.error("Erro ao excluir item:", e);
      return false;
    }
  },

  async getUsers() {
    if (!AuthService.isAdmin()) throw new Error("permission-denied");
    const snap = await getDocs(collection(db, "users"));
    return snap.docs.map((d) => d.data());
  },

  async toggleUserStatus(uid, currentStatus) {
    if (!AuthService.isAdmin()) throw new Error("permission-denied");
    const docRef = doc(db, "users", uid);
    await updateDoc(docRef, { active: !currentStatus });
    return !currentStatus;
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
          plan: "enterprise",
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
  async handleDemoLogin(btn) {
    const originalHTML = btn ? btn.innerHTML : "";
    if (btn) {
      btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 text-slate-400 animate-spin"></i> Acessando...`;
      btn.disabled = true;
      lucide.createIcons();
    }

    const demoEmail = "demo@serob.com";
    const demoPass = "demo1234";

    try {
      await AuthService.login(demoEmail, demoPass, false);
      const errEl = document.getElementById("login-error");
      errEl?.classList.add("hidden");

      // ROTINA DE LIMPEZA DIÁRIA PARA A CONTA DEMO
      const user = auth.currentUser;
      if (user) {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) {
          const data = snap.data();
          const lastReset = data.lastReset?.toDate() || new Date(0);
          const now = new Date();
          const isSameDay =
            lastReset.getDate() === now.getDate() &&
            lastReset.getMonth() === now.getMonth() &&
            lastReset.getFullYear() === now.getFullYear();

          if (!isSameDay) {
            if (btn) {
              btn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 text-slate-400 animate-spin"></i> Restaurando ambiente...`;
              lucide.createIcons();
            }
            await setDoc(
              doc(db, "users", user.uid),
              { lastReset: serverTimestamp() },
              { merge: true },
            );
            await FirestoreService.resetData();
            return; // A página vai recarregar automaticamente no resetData
          }
        }
      }

      App.initLayout();
    } catch (err) {
      // Se a conta não existe, cria ela invisivelmente na hora
      if (
        err.code === "auth/invalid-credential" ||
        err.code === "auth/user-not-found" ||
        err.code === "auth/wrong-password"
      ) {
        try {
          const userCred = await createUserWithEmailAndPassword(
            auth,
            demoEmail,
            demoPass,
          );
          await setDoc(
            doc(db, "users", userCred.user.uid),
            {
              uid: userCred.user.uid,
              email: demoEmail,
              name: "Visitante Demo",
              role: "admin", // Admin para permitir explorar tudo
              label: "Modo Demonstração",
              plan: "enterprise",
              active: true,
              tenantName: "Empresa Demonstrativa",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              lastReset: serverTimestamp(), // Registra a data da limpeza
            },
            { merge: true },
          );
          App.initLayout();
        } catch (createErr) {
          console.error("Erro ao gerar conta demo:", createErr);
          ToastManager.show(
            "Falha ao gerar ambiente de demonstração.",
            "error",
          );
        }
      } else {
        console.error(err);
        ToastManager.show(
          "Erro de conexão ao acessar a demonstração.",
          "error",
        );
      }
    } finally {
      if (btn) {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        lucide.createIcons();
      }
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
    sortCol: "descricao",
    sortDesc: false,
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
  sortItems(col) {
    if (this.state.sortCol === col) {
      this.state.sortDesc = !this.state.sortDesc;
    } else {
      this.state.sortCol = col;
      this.state.sortDesc = false;
    }
    this.state.currentPage = 1;
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

  openEditModal(itemId) {
    const item = FirestoreService.items.find(
      (i) => String(i.id) === String(itemId),
    );
    if (!item) {
      ToastManager.show("Material não encontrado.", "error");
      return;
    }
    document.getElementById("edit-id").value = item.id;
    document.getElementById("edit-descricao").value = item.descricao || "";
    document.getElementById("edit-codigo-interno").value =
      item.codigoInterno || "";
    document.getElementById("edit-codigo").value = item.codigo || "";
    document.getElementById("edit-categoria").value = item.categoria || "";
    document.getElementById("edit-unidade").value =
      item.unidade || item.unidadeEntrada || "";
    document.getElementById("edit-minimo").value = item.estoqueMinimo || 0;
    document.getElementById("edit-ressup").value = item.qtdRessuprimento || 0;

    ModalManager.open("modal-edit-item");
  },

  async saveEditItem(e) {
    e.preventDefault();
    const id = document.getElementById("edit-id").value;
    const updates = {
      descricao: document.getElementById("edit-descricao").value.trim(),
      codigoInterno: document
        .getElementById("edit-codigo-interno")
        .value.trim(),
      codigo: document.getElementById("edit-codigo").value.trim(),
      categoria: document.getElementById("edit-categoria").value.trim(),
      unidade: document.getElementById("edit-unidade").value.trim(),
      estoqueMinimo:
        parseFloat(document.getElementById("edit-minimo").value) || 0,
      qtdRessuprimento:
        parseFloat(document.getElementById("edit-ressup").value) || 0,
    };
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = "Salvando...";
    btn.disabled = true;
    try {
      const success = await FirestoreService.updateItem(id, updates);
      if (success) {
        ToastManager.show("Material atualizado com sucesso!");
        ModalManager.close("modal-edit-item");
      } else {
        ToastManager.show("Erro ao atualizar material.", "error");
      }
    } catch (err) {
      ToastManager.show(
        err.message === "permission-denied"
          ? "Acesso negado."
          : "Erro inesperado.",
        "error",
      );
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
  },

  async deleteItem(itemId) {
    if (
      !confirm("Tem certeza que deseja excluir este material permanentemente?")
    )
      return;
    try {
      const success = await FirestoreService.deleteItem(itemId);
      if (success)
        ToastManager.show("Material excluído com sucesso!", "success");
      else ToastManager.show("Erro ao excluir material.", "error");
    } catch (err) {
      ToastManager.show(
        err.message === "permission-denied"
          ? "Acesso negado."
          : "Erro inesperado.",
        "error",
      );
    }
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

    const tenantName = FirestoreService.profile?.tenantName || "Empresa";
    const pageWidth = doc.internal.pageSize.width;

    // Título Principal (Esquerda)
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59); // text-slate-800
    doc.text("SEROB", 14, 20);

    // Título Secundário (Direita)
    doc.setFontSize(14);
    doc.text("Relatório de Posição de Estoque", pageWidth - 14, 18, {
      align: "right",
    });

    // Subtítulo dinâmico (Direita)
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139); // text-slate-500
    doc.text(
      `Emissão: ${new Date().toLocaleString("pt-BR")} | Empresa: ${tenantName}`,
      pageWidth - 14,
      24,
      { align: "right" },
    );

    // Linha divisória fina cinza
    doc.setDrawColor(226, 232, 240); // border-slate-200
    doc.setLineWidth(0.5);
    doc.line(14, 28, pageWidth - 14, 28);

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
      startY: 34,
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

    const pageCount = doc.internal.getNumberOfPages();
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.text(
        `Página ${i} de ${pageCount}`,
        pageWidth - 14,
        doc.internal.pageSize.height - 10,
        { align: "right" },
      );
    }

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
  isDarkMode: false,
  historySortCol: "date",
  historySortDesc: true,
  sortHistory(col) {
    if (this.historySortCol === col) {
      this.historySortDesc = !this.historySortDesc;
    } else {
      this.historySortCol = col;
      this.historySortDesc = false;
    }
    this.renderHistoryTableRows();
  },
  applyDarkMode() {
    this.isDarkMode = localStorage.getItem("serob_dark_mode") === "true";
    if (this.isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    this.updateDarkModeUI();
  },
  toggleDarkMode() {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem("serob_dark_mode", this.isDarkMode);
    if (this.isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    this.updateDarkModeUI();
    if (this.currentTab === "dashboard") this.renderChart();
  },
  updateDarkModeUI() {
    const icon = document.getElementById("dark-mode-icon");
    const text = document.getElementById("dark-mode-text");
    if (icon && text) {
      icon.setAttribute("data-lucide", this.isDarkMode ? "sun" : "moon");
      text.innerText = this.isDarkMode ? "Modo Claro" : "Modo Noturno";
      lucide.createIcons();
    }
  },
  changeDashboardPeriod(days) {
    this.dashboardPeriod = days;
    this.renderDashboard();
  },
  changeDashboardCategory(cat) {
    this.dashboardCategory = cat;
    this.renderDashboard();
  },

  // --- OTIMIZAÇÃO: Gerenciador de Views (Cache de Layout) ---
  getOrCreateView(viewId) {
    const container = document.getElementById("content-area");
    // Oculta todas as outras telas criadas anteriormente
    Array.from(container.children).forEach((child) =>
      child.classList.add("hidden"),
    );

    let view = document.getElementById(`view-${viewId}`);
    if (!view) {
      view = document.createElement("div");
      view.id = `view-${viewId}`;
      view.className = "w-full h-full animate-fade-in";
      container.appendChild(view);
    }
    view.classList.remove("hidden");
    return view;
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
        this.toggleSubmenu("submenu-material", true); // Ignora a expansão automática
      }
      texts.forEach((t) => t.classList.add("hidden"));
      if (logoText) logoText.classList.add("hidden");
      if (arrow) arrow.classList.add("hidden");
      if (icon) icon.classList.add("rotate-180");
    } else {
      sidebar.classList.replace("xl:w-20", "xl:w-72");
      setTimeout(() => {
        texts.forEach((t) => t.classList.remove("hidden"));
        if (logoText) logoText.classList.remove("hidden");
        if (arrow) arrow.classList.remove("hidden");
      }, 150);
      if (icon) icon.classList.remove("rotate-180");
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
      let nonZeroDays = 0;
      const dataPoints = [];

      for (let i = 0; i <= dashboardPeriod; i++) {
        const y = itemDaily[i] || 0;
        if (y > 0) nonZeroDays++;
        dataPoints.push(y);
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

      // IA: Cálculo de Variância e Desvio Padrão (Volatilidade)
      const variance =
        dataPoints.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / n;
      const stdDev = Math.sqrt(variance);

      let projectedRate = avg;
      if (m !== 0) {
        const endRate = m * dashboardPeriod + b;
        projectedRate = Math.max(0, (endRate + avg) / 2); // Suaviza o peso da regressão
        // Se a tendência for de alta, dá 70% de peso pro crescimento. Se for baixa, suaviza 50/50.
        projectedRate =
          m > 0 ? endRate * 0.7 + avg * 0.3 : Math.max(0, (endRate + avg) / 2);
      }
      if (avg === 0) projectedRate = 0;

      // IA: Cálculo Avançado de Supply Chain
      const leadTime = 7; // Assumindo default de 7 dias para o fornecedor entregar
      const zScore = 1.65; // Z-Score para Nível de Serviço de 95% (Não faltar em 95% dos casos)
      const safetyStock = Math.ceil(zScore * stdDev * Math.sqrt(leadTime));
      const reorderPoint =
        Math.ceil(projectedRate * leadTime) +
        safetyStock +
        Number(item.estoqueMinimo);

      // Score de Confiança da IA (Baseado em consistência de dados no período)
      const confidence = Math.min(
        100,
        Math.round((nonZeroDays / (dashboardPeriod * 0.4)) * 100),
      );

      let suggQty = Math.max(
        Number(item.qtdRessuprimento) || 0,
        Number(item.estoqueMinimo) * 2 - Number(item.estoque),
      );
      if (projectedRate > 0) {
        const optimalStock =
          Math.ceil(projectedRate * dashboardPeriod) +
          safetyStock +
          Number(item.estoqueMinimo);
        const needed = optimalStock - Number(item.estoque);
        if (needed > suggQty) suggQty = needed;
      }

      return {
        m,
        avg,
        projectedRate,
        suggQty,
        stdDev,
        safetyStock,
        reorderPoint,
        confidence,
      };
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

    let plainText =
      "Prezados(as),\n\nIdentificamos que os seguintes itens atingiram o nível crítico de estoque. Segue a sugestão de reposição projetada pela Inteligência Artificial:\n\n";
    plainText +=
      "+---------------+---------------------------------------+-------+---------+\n";
    plainText +=
      "| CÓDIGO        | MATERIAL                              | SALDO | COMPRAR |\n";
    plainText +=
      "+---------------+---------------------------------------+-------+---------+\n";

    let totalComprar = 0;

    criticalItems.forEach((i) => {
      const { suggQty } = predictor(i);
      const codigo = String(i.codigo || "S/N");
      const saldo = String(i.estoque || 0);
      const sug = String(suggQty || 0);
      const desc = String(i.descricao || "");

      const codigoPad = codigo.padEnd(15, " ");
      const descPad = (
        desc.length > 39 ? desc.substring(0, 36) + "..." : desc
      ).padEnd(39, " ");
      const saldoPad = saldo.padStart(5, " ");
      const sugPad = sug.padStart(7, " ");

      totalComprar += Number(suggQty) || 0;

      plainText += `| ${codigoPad} | ${descPad} | ${saldoPad} | ${sugPad} |\n`;
    });

    const spaceCode = "".padEnd(15, " ");
    const labelTotal = "TOTAL A COMPRAR".padStart(39, " ");
    const spaceSaldo = "".padStart(5, " ");
    const valTotal = String(totalComprar).padStart(7, " ");

    plainText +=
      "+---------------+---------------------------------------+-------+---------+\n";
    plainText += `| ${spaceCode} | ${labelTotal} | ${spaceSaldo} | ${valTotal} |\n`;
    plainText +=
      "+---------------+---------------------------------------+-------+---------+\n";

    const bodyStr = encodeURIComponent(plainText);
    const subjStr = encodeURIComponent(
      "ALERTA PREDITIVO: Sugestão de Reposição de Estoque",
    );

    setTimeout(() => {
      if (btn) {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        lucide.createIcons();
      }
      window.location.href = `mailto:jefferson.araujo@camara.leg.br?subject=${subjStr}&body=${bodyStr}`;
      ToastManager.show(
        "Alerta estruturado e aberto no seu cliente de email!",
        "success",
      );
    }, 1200);
  },
  downloadPurchasePDF() {
    const criticalItems = FirestoreService.items.filter(
      (i) => (Number(i.estoque) || 0) <= (Number(i.estoqueMinimo) || 0),
    );
    if (criticalItems.length === 0)
      return ToastManager.show("Nenhum item crítico para relatar.", "warning");

    if (!window.jspdf) {
      return ToastManager.show("Módulo PDF carregando...", "warning");
    }

    const predictor = this.getPredictionModel(this.dashboardPeriod);
    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF("portrait");

    docPdf.setFontSize(16);
    docPdf.text("Relatório Preditivo de Compras - SEROB", 14, 20);
    docPdf.setFontSize(10);
    docPdf.text(`Emitido em: ${new Date().toLocaleString("pt-BR")}`, 14, 28);

    const tableDataForPdf = [];
    let totalComprar = 0;

    criticalItems.forEach((i) => {
      const { suggQty } = predictor(i);
      totalComprar += Number(suggQty) || 0;
      tableDataForPdf.push([
        String(i.codigo || "S/N"),
        String(i.descricao || ""),
        String(i.estoque || 0),
        String(suggQty || 0),
      ]);
    });

    tableDataForPdf.push(["", "", "TOTAL GERAL:", String(totalComprar)]);

    docPdf.autoTable({
      startY: 35,
      head: [["Código", "Material / Descrição", "Saldo Atual", "Comprar"]],
      body: tableDataForPdf,
      theme: "striped",
      styles: { fontSize: 9 },
      headStyles: { fillColor: [37, 99, 235] },
    });

    const pageCount = docPdf.internal.getNumberOfPages();
    docPdf.setFontSize(8);
    docPdf.setTextColor(100, 116, 139);
    for (let i = 1; i <= pageCount; i++) {
      docPdf.setPage(i);
      docPdf.text(
        `Página ${i} de ${pageCount}`,
        docPdf.internal.pageSize.width - 14,
        docPdf.internal.pageSize.height - 10,
        { align: "right" },
      );
    }

    docPdf.save(`sugestao_compras_${new Date().getTime()}.pdf`);
    ToastManager.show(
      "Lista de compras gerada e baixada com sucesso!",
      "success",
    );
  },
  exportDashboardToPDF() {
    if (!window.jspdf) {
      ToastManager.show("Módulo PDF carregando...", "warning");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("portrait");
    const now = new Date();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - this.dashboardPeriod);

    const baseItems =
      this.dashboardCategory === "Todas"
        ? FirestoreService.items
        : FirestoreService.items.filter(
            (i) => i.categoria === this.dashboardCategory,
          );
    const itemCatMap = {};
    FirestoreService.items.forEach((i) => (itemCatMap[i.id] = i.categoria));
    const baseMovements = (FirestoreService.movements || []).filter((m) =>
      this.dashboardCategory === "Todas"
        ? true
        : itemCatMap[m.itemId] === this.dashboardCategory,
    );

    let totalEntradas = 0,
      totalSaidas = 0,
      totalEstoque = 0;
    baseItems.forEach((i) => {
      totalEstoque += Number(i.estoque) || 0;
    });
    baseMovements.forEach((m) => {
      if (m.date && m.date.toDate) {
        const d = m.date.toDate();
        if (d >= targetDate) {
          if (m.type === "entrada") totalEntradas += Number(m.qty) || 0;
          if (m.type === "saida") totalSaidas += Number(m.qty) || 0;
        }
      }
    });
    const lowStockCount = baseItems.filter((i) => {
      const est = Number(i.estoque) || 0;
      const min = Number(i.estoqueMinimo) || 0;
      return est > 0 && est <= min;
    }).length;
    const outOfStockCount = baseItems.filter(
      (i) => (Number(i.estoque) || 0) <= 0,
    ).length;

    doc.setFontSize(16);
    doc.text("Relatório do Painel Executivo - SEROB", 14, 20);
    doc.setFontSize(10);
    doc.text(
      `Período analisado: Últimos ${this.dashboardPeriod} dias | Categoria: ${this.dashboardCategory}`,
      14,
      28,
    );
    doc.text(`Emitido em: ${now.toLocaleString("pt-BR")}`, 14, 34);

    doc.autoTable({
      startY: 40,
      head: [["Métrica de KPI", "Valor"]],
      body: [
        ["Total de Cadastros", baseItems.length.toString()],
        ["Itens em Estoque", App.formatNumber(totalEstoque, 0)],
        ["Entradas (Unidades)", App.formatNumber(totalEntradas, 0)],
        ["Saídas (Unidades)", App.formatNumber(totalSaidas, 0)],
        ["Itens Críticos", lowStockCount.toString()],
        ["Itens Esgotados", outOfStockCount.toString()],
      ],
      theme: "grid",
      headStyles: { fillColor: [37, 99, 235] },
      margin: { left: 14, right: 14 },
    });

    const criticalItems = baseItems.filter(
      (i) => (Number(i.estoque) || 0) <= (Number(i.estoqueMinimo) || 0) * 1.4,
    );
    if (criticalItems.length > 0) {
      doc.text(
        "Itens em Nível Crítico ou Alerta:",
        14,
        doc.lastAutoTable.finalY + 12,
      );
      const critData = criticalItems
        .slice(0, 30)
        .map((i) => [
          i.codigo || "-",
          i.descricao || "-",
          i.estoque || 0,
          i.estoqueMinimo || 0,
        ]);
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 16,
        head: [["Código", "Descrição", "Saldo Atual", "Mínimo"]],
        body: critData,
        theme: "striped",
        styles: { fontSize: 8 },
        headStyles: { fillColor: [225, 29, 72] }, // bg-rose-600
      });
    }

    const pageCount = doc.internal.getNumberOfPages();
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.text(
        `Página ${i} de ${pageCount}`,
        doc.internal.pageSize.width - 14,
        doc.internal.pageSize.height - 10,
        { align: "right" },
      );
    }

    doc.save(`dashboard_resumo_${now.getTime()}.pdf`);
    ToastManager.show("Relatório do Dashboard gerado com sucesso!", "success");
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

    const filterSels = document.querySelectorAll("#filter-categoria");
    if (filterSels.length > 0) {
      const currentFilter = InventoryController.state.categoryFilter || "Todas";
      filterSels.forEach((fSel) => {
        const has = Array.from(fSel.options).some(
          (o) => o.value === currentFilter,
        );
        if (has) {
          fSel.value = currentFilter;
        } else {
          fSel.value = "Todas";
          InventoryController.state.categoryFilter = "Todas";
        }
      });
    }
  },
  async init() {
    AuthService.restoreSession();
    this.applyDarkMode();
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
      this.currentTab === "stock-favorites" ||
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
  exportDatabaseJSON() {
    if (!AuthService.isAdmin()) {
      return ToastManager.show("Sem permissão para exportar backup.", "error");
    }

    const data = {
      timestamp: new Date().toISOString(),
      tenant: FirestoreService.profile?.tenantName || "Unknown",
      items: FirestoreService.items || [],
      movements: FirestoreService.movements || [],
      deposits: FirestoreService.deposits || [],
    };

    const dataStr = JSON.stringify(data, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup_serob_${new Date().getTime()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ToastManager.show("Backup exportado com sucesso!", "success");
  },
  restoreDatabaseJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!AuthService.isAdmin()) {
      ToastManager.show("Sem permissão para restaurar backup.", "error");
      event.target.value = "";
      return;
    }

    if (
      !confirm(
        "ATENÇÃO: Restaurar um backup irá sobrescrever/mesclar os dados atuais do banco com os do arquivo. Recomenda-se exportar um backup antes. Deseja continuar?",
      )
    ) {
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.items) {
          throw new Error("Arquivo JSON inválido ou formato incompatível.");
        }

        ToastManager.show("Restaurando backup... Aguarde.", "warning");

        const writeInBatches = async (collectionName, itemsArray) => {
          if (!itemsArray || itemsArray.length === 0) return;
          for (let i = 0; i < itemsArray.length; i += 500) {
            const chunk = itemsArray.slice(i, i + 500);
            const batch = writeBatch(db);
            chunk.forEach((item) => {
              const docId = item.id
                ? String(item.id)
                : doc(collection(db, collectionName)).id;
              const docRef = doc(db, collectionName, docId);
              batch.set(docRef, item);
            });
            await batch.commit();
          }
        };

        await writeInBatches("items", data.items);
        if (data.movements) await writeInBatches("movements", data.movements);
        if (data.deposits) await writeInBatches("deposits", data.deposits);

        ToastManager.show(
          "Backup restaurado com sucesso! Recarregando...",
          "success",
        );
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        console.error("Erro ao restaurar JSON:", err);
        ToastManager.show(
          err.message || "Erro ao ler o arquivo de backup.",
          "error",
        );
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  },
  initLayout() {
    // --- Verificação de Expiração do Plano Starter (Teste de 24h) ---
    const profile = FirestoreService.profile;
    if (profile) {
      const plan = profile.plan || "starter";
      if (plan === "starter" && profile.createdAt) {
        let createdDate = new Date();
        if (typeof profile.createdAt.toDate === "function") {
          createdDate = profile.createdAt.toDate();
        } else if (profile.createdAt.seconds) {
          createdDate = new Date(profile.createdAt.seconds * 1000);
        }
        const hoursElapsed = (new Date() - createdDate) / (1000 * 60 * 60);
        if (hoursElapsed > 24) {
          alert(
            "Seu período de teste grátis de 24h expirou!\n\nEntre em contato com um consultor para assinar um de nossos planos e continuar usando o sistema.",
          );
          window.open(
            "https://wa.me/5511999999999?text=Ol%C3%A1%2C%20meu%20teste%20expirou%20e%20gostaria%20de%20assinar%20o%20sistema.",
            "_blank",
          );
          this.logout();
          return;
        } else {
          // Derruba a sessão automaticamente se as 24h vencerem enquanto ele usa o app
          const msLeft = 24 * 60 * 60 * 1000 - (new Date() - createdDate);
          if (msLeft > 0) {
            setTimeout(() => {
              alert(
                "Seu período de teste grátis de 24h expirou!\n\nSua sessão será encerrada para proteção.",
              );
              this.logout();
            }, msLeft);
          }
        }
      }
    }

    document.getElementById("login-layout").classList.add("hidden");
    const regLayout = document.getElementById("register-layout");
    if (regLayout) {
      regLayout.classList.add("hidden");
      regLayout.classList.remove("flex");
    }
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

    // Correção: Garante que a área principal tenha scroll para suportar a Dashboard
    if (contentArea) {
      contentArea.classList.add("overflow-y-auto", "overflow-x-hidden");
      contentArea.classList.remove("overflow-hidden");
    }

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

    let iconHtml = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="w-full h-full p-1.5 fill-current"><path d="M15.71,12.71a6,6,0,1,0-7.42,0,10,10,0,0,0-6.22,8.18,1,1,0,0,0,2,.22,8,8,0,0,1,15.9,0,1,1,0,0,0,1,.89h.11a1,1,0,0,0,.88-1.1A10,10,0,0,0,15.71,12.71ZM12,12a4,4,0,1,1,4-4A4,4,0,0,1,12,12Z"/></svg>`;
    if (user.avatarUrl) {
      iconHtml = `<img src="${Utils.escapeHTML(user.avatarUrl)}" alt="Avatar" class="w-full h-full object-cover rounded-full bg-white" />`;
    }
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

    // Validação do Modo de Demonstração
    const demoBadge = document.getElementById("demo-warning-badge");
    if (demoBadge) {
      if (user.email === "demo@serob.com") {
        demoBadge.classList.remove("hidden");
        demoBadge.classList.add("flex");
      } else {
        demoBadge.classList.add("hidden");
        demoBadge.classList.remove("flex");
      }
    }
    this.updateLandingUI();
  },
  updateLandingUI() {
    const user = AuthService.getCurrentUser();
    const desktopAuth = document.getElementById("desktop-landing-auth");
    const mobileAuth = document.getElementById("mobile-landing-auth");
    const heroAuth = document.getElementById("hero-auth-buttons");

    if (user) {
      const firstName = (user.name || "Usuário").split(" ")[0];
      if (desktopAuth) {
        desktopAuth.innerHTML = `<button onclick="window.showApp()" class="flex items-center gap-2 px-4 py-2 bg-brand-50 text-brand-600 font-bold rounded-xl hover:bg-brand-100 transition-colors shadow-sm"><div class="w-6 h-6 rounded-full bg-brand-200 flex items-center justify-center text-brand-700 text-xs"><i data-lucide="user" class="w-3 h-3"></i></div> Olá, ${Utils.escapeHTML(firstName)}</button>`;
      }
      if (mobileAuth) {
        mobileAuth.innerHTML = `<button onclick="document.getElementById('mobile-menu').classList.add('hidden'); window.showApp();" class="text-white bg-brand-600 hover:bg-brand-700 py-3 rounded-xl shadow-lg shadow-brand-600/20 transition-all active:scale-95 flex items-center justify-center gap-2"><i data-lucide="layout-dashboard" class="w-5 h-5"></i> Acessar Painel</button>`;
      }
      if (heroAuth) {
        heroAuth.innerHTML = `<button onclick="window.showApp()" class="px-8 py-4 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-2xl shadow-xl shadow-brand-600/30 transition-all transform hover:-translate-y-1 flex items-center justify-center gap-2">Ir para o Painel <i data-lucide="arrow-right" class="w-5 h-5"></i></button>`;
      }
    } else {
      if (desktopAuth) {
        desktopAuth.innerHTML = `<button onclick="window.showLogin()" class="text-brand-600 hover:text-brand-700 font-bold">Fazer Login</button>`;
      }
      if (mobileAuth) {
        mobileAuth.innerHTML = `<button onclick="document.getElementById('mobile-menu').classList.add('hidden'); window.showLogin();" class="text-white bg-brand-600 hover:bg-brand-700 py-3 rounded-xl shadow-lg shadow-brand-600/20 transition-all active:scale-95">Fazer Login</button>`;
      }
      if (heroAuth) {
        heroAuth.innerHTML = `<button onclick="window.showRegister()" class="px-8 py-4 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-2xl shadow-xl shadow-brand-600/30 transition-all transform hover:-translate-y-1 flex items-center justify-center gap-2">Testar Gratuitamente <i data-lucide="arrow-right" class="w-5 h-5"></i></button><button onclick="AuthController.handleDemoLogin(this)" class="px-8 py-4 bg-white hover:bg-slate-50 text-slate-700 font-bold rounded-2xl shadow-sm border border-slate-200 transition-all flex items-center justify-center gap-2"><i data-lucide="play-circle" class="w-5 h-5 text-slate-400"></i> Ver Demonstração</button>`;
      }
    }
    lucide.createIcons();
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
    const prevTab = this.currentTab;
    this.currentTab = tab;

    const pageTitles = {
      dashboard: "Visão Geral",
      "stock-search": "Pesquisa de Estoque",
      "stock-favorites": "Itens Favoritos",
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
        "stock-favorites": "nav-stock-favorites",
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

      if (tab === "stock-search" || tab === "stock-favorites")
        this.renderStockSearch();
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
    if (sidebar.classList.contains("-translate-x-full")) {
      overlay.classList.add("opacity-0");
      // Aguarda a animação terminar antes de ocultar do layout
      setTimeout(() => overlay.classList.add("hidden"), 300);
    } else {
      overlay.classList.remove("hidden");
      // Força o navegador a desenhar o elemento antes de iniciar a transição
      requestAnimationFrame(() => overlay.classList.remove("opacity-0"));
    }
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
  openProfileModal() {
    const u = AuthService.getCurrentUser();
    if (!u) return;
    document.getElementById("profile-name").value = u.name || "";
    document.getElementById("profile-avatar").value = u.avatarUrl || "";
    ModalManager.open("modal-profile");
  },
  async saveProfile(e) {
    e.preventDefault();
    const u = auth.currentUser;
    if (!u) return;

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Salvando...`;
    btn.disabled = true;
    lucide.createIcons();

    const newName = document.getElementById("profile-name").value.trim();
    const newAvatar = document.getElementById("profile-avatar").value.trim();

    try {
      await setDoc(
        doc(db, "users", u.uid),
        {
          name: newName,
          avatarUrl: newAvatar,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      if (FirestoreService.profile) {
        FirestoreService.profile.name = newName;
        FirestoreService.profile.avatarUrl = newAvatar;
      }
      this.updateUserProfile();
      ToastManager.show("Perfil atualizado com sucesso!", "success");
      ModalManager.close("modal-profile");
    } catch (err) {
      console.error(err);
      ToastManager.show("Erro ao atualizar o perfil.", "error");
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
      lucide.createIcons();
    }
  },
  renderStockSearch() {
    if (!AuthService.getCurrentUser()) return;
    // Usa a mesma view base para evitar duplicação de IDs HTML (inventory-body) no DOM
    const view = this.getOrCreateView("stock-search");
    const vid = "stock-search";

    // Se a view for nova, injeta o layout estrutural. Caso contrário, ele já está na memória!
    if (view.innerHTML === "") {
      view.innerHTML = `
      <div class="space-y-4 h-full flex flex-col min-h-0 animate-fade-in max-w-7xl mx-auto">
        <div class="bg-white p-6 rounded-3xl border border-slate-200/60 shadow-sm relative overflow-hidden">
          <div class="absolute top-0 left-0 w-1 h-full bg-brand-500"></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4 flex items-center gap-2"><i data-lucide="filter" class="w-4 h-4"></i> Filtros de Busca</p>
          <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div class="md:col-span-3"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Nome / Descrição</label><input type="text" id="search-name" autocomplete="off" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm" placeholder="Digite o nome..." onkeyup="InventoryController.handleAdvancedSearch()"></div>
            <div class="md:col-span-2"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Código</label><input type="text" id="search-code" autocomplete="off" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm" placeholder="Ex: 12345" onkeyup="InventoryController.handleAdvancedSearch()"></div>
            <div class="md:col-span-2"><label class="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Status</label><select id="search-status" onchange="InventoryController.handleAdvancedSearch()" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none bg-slate-50 focus:bg-white shadow-sm transition-all text-sm cursor-pointer appearance-none"><option value="Todos">Todos</option><option value="Normal">Normal</option><option value="Alerta">Alerta</option><option value="Critico">Crítico</option><option value="Esgotado">Esgotado</option></select></div>
            <div class="md:col-span-2"><button onclick="InventoryController.handleAdvancedSearch()" class="w-full px-4 py-3 bg-brand-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-brand-700 transition-all flex items-center justify-center gap-2 active:scale-95"><i data-lucide="refresh-cw" class="w-4 h-4"></i> Atualizar</button></div>
            <div class="md:col-span-3 flex gap-2">
              <button onclick="InventoryController.exportToCSV()" class="flex-1 px-4 py-3 bg-emerald-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar Excel"><i data-lucide="file-spreadsheet" class="w-4 h-4"></i> CSV</button>
              <button onclick="InventoryController.exportToPDF()" class="flex-1 px-4 py-3 bg-red-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-red-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar PDF"><i data-lucide="file-text" class="w-4 h-4"></i> PDF</button>
            </div>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col shadow-none md:shadow-sm min-h-0">
          <div class="overflow-auto flex-1 custom-scrollbar">
            <table class="block md:table w-full text-sm text-left relative">
              <thead class="hidden md:table-header-group bg-slate-50/80 backdrop-blur-md text-slate-500 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-20 border-b border-slate-200/80">
                <tr><th class="px-4 py-3 w-28 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('codigo')">Código <span id="sort-icon-${vid}-codigo"></span></th><th class="px-4 py-3 w-24 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('codigoInterno')">Cód. Int. <span id="sort-icon-${vid}-codigoInterno"></span></th><th class="px-4 py-3 min-w-[200px] cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('descricao')">Descrição <span id="sort-icon-${vid}-descricao"></span></th><th class="px-4 py-3 text-center w-20 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('unidade')">Unid. <span id="sort-icon-${vid}-unidade"></span></th><th class="px-4 py-3 text-center w-24 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('estoque')">Saldo <span id="sort-icon-${vid}-estoque"></span></th><th class="px-4 py-3 text-center w-20 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('estoqueMinimo')">Mín. <span id="sort-icon-${vid}-estoqueMinimo"></span></th><th class="px-4 py-3 text-center w-20 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="InventoryController.sortItems('qtdRessuprimento')">Ressup. <span id="sort-icon-${vid}-qtdRessuprimento"></span></th><th class="px-4 py-3 text-center w-24">Status</th><th class="px-4 py-3 text-right w-16"></th></tr>
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
    } else {
      // Se a interface já existia, sincroniza os inputs visuais com o reset de filtros
      const elGlobal = view.querySelector(
        'input[placeholder*="Buscar código"]',
      );
      if (elGlobal) elGlobal.value = InventoryController.state.searchTerm;
      const elName = document.getElementById("search-name");
      if (elName) elName.value = InventoryController.state.searchName;
      const elCode = document.getElementById("search-code");
      if (elCode) elCode.value = InventoryController.state.searchCode;
      const elCat = document.getElementById("filter-categoria");
      if (elCat) elCat.value = InventoryController.state.categoryFilter;
      const elStatus = document.getElementById("search-status");
      if (elStatus) elStatus.value = InventoryController.state.statusFilter;
    }
    // Independente se recriou a view ou não, sempre atualizamos os dados da tabela
    this.renderTableRows();
  },
  renderDashboard() {
    const user = AuthService.getCurrentUser();
    if (!user) return;
    const view = this.getOrCreateView("dashboard");

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

    // No Dashboard optamos por recarregar tudo devido aos gráficos e KPIs fortemente dinâmicos
    // Para uma performance total no futuro, eles também poderiam ser atualizados granularmente
    view.innerHTML = `
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
                <select onchange="App.changeDashboardCategory(this.value)" class="appearance-none w-full bg-slate-50 border-0 ring-1 ring-slate-200 focus:bg-white text-slate-700 py-2.5 pl-4 pr-10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm font-semibold cursor-pointer shadow-sm transition-all">
                  ${categoriesList.map((c) => `<option value="${c}" ${this.dashboardCategory === c ? "selected" : ""}>${c}</option>`).join("")}
                </select>
                <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="m6 9 6 6 6-6"></path></svg></div>
             </div>
             <div class="flex gap-1 bg-slate-50 p-1 rounded-2xl ring-1 ring-slate-200 shadow-sm">
               <button onclick="App.changeDashboardPeriod(7)" class="${this.dashboardPeriod === 7 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 font-semibold"} flex-1 px-4 py-1.5 rounded-xl text-sm transition-all duration-200">7 Dias</button>
               <button onclick="App.changeDashboardPeriod(30)" class="${this.dashboardPeriod === 30 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 font-semibold"} flex-1 px-4 py-1.5 rounded-xl text-sm transition-all duration-200">30 Dias</button>
               <button onclick="App.changeDashboardPeriod(90)" class="${this.dashboardPeriod === 90 ? "bg-white shadow text-brand-600 font-bold" : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 font-semibold"} flex-1 px-4 py-1.5 rounded-xl text-sm transition-all duration-200">90 Dias</button>
             </div>
             <button onclick="App.exportDashboardToPDF()" class="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-2xl shadow-sm hover:bg-red-700 transition-all active:scale-95" title="Exportar Resumo em PDF"><i data-lucide="file-text" class="w-4 h-4"></i> PDF</button>
          </div>
        </div>

        <!-- 5 KPIs -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          ${this._createCard("Total de Cadastros", stats.totalItems, "database", "purple")}
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
                 <button onclick="App.downloadPurchasePDF()" class="flex-1 sm:flex-none text-[11px] flex justify-center items-center gap-1.5 font-bold text-rose-700 bg-rose-50 border border-rose-200 px-3 py-2.5 rounded-xl hover:bg-rose-100 transition-colors shadow-sm active:scale-95" title="Baixar Lista em PDF"><i data-lucide="file-down" class="w-3.5 h-3.5"></i> Baixar PDF</button>
                 <button id="btn-avisar-compras" onclick="App.sendPurchaseAlert()" class="flex-1 sm:flex-none text-[11px] flex justify-center items-center gap-1.5 font-bold text-white bg-indigo-600 px-3 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors shadow-sm active:scale-95"><i data-lucide="zap" class="w-3.5 h-3.5"></i> Automação Email</button>
                 <button onclick="App.navigate('stock-search')" class="flex-1 sm:flex-none text-[11px] flex justify-center items-center font-bold text-brand-600 bg-brand-50 px-3 py-2.5 rounded-xl hover:bg-brand-100 transition-colors active:scale-95">Ver Estoque</button>
               </div>
            </div>
            <div class="overflow-auto p-2 md:p-0 custom-scrollbar max-h-96"><table class="block md:table w-full text-sm text-left"><thead class="hidden md:table-header-group bg-slate-50 text-slate-500 font-semibold uppercase text-[10px] tracking-wider sticky top-0 z-20"><tr><th class="px-5 py-3">Material / Tendência</th><th class="px-5 py-3 text-right">Saldo / Setup</th><th class="px-5 py-3 text-center">Esgota Em ✨</th><th class="px-5 py-3 text-center">Sugestão IA</th></tr></thead><tbody class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 space-y-3 md:space-y-0">${
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

                  const { m, projectedRate, suggQty, confidence, safetyStock } =
                    predictor(item);

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

                  // Colorir a barra de confiança da IA
                  let confColor =
                    confidence > 70
                      ? "bg-emerald-500"
                      : confidence > 40
                        ? "bg-amber-500"
                        : "bg-red-500";
                  let confText =
                    confidence > 70
                      ? "Alta"
                      : confidence > 40
                        ? "Média"
                        : "Baixa";

                  const suggHtml = isCritical
                    ? `<div class="text-indigo-600 font-bold mt-2 text-[10px] bg-indigo-50 px-2.5 py-1 rounded border border-indigo-100 w-max md:mx-auto" title="IA Sugere reposição baseada na curva de regressão">Sugerido: Compra de ${suggQty}</div>`
                    : `<div class="text-slate-500 font-bold mt-2 text-[10px] bg-slate-50 px-2.5 py-1 rounded border border-slate-200 w-max md:mx-auto">Comprar: ${suggQty} un</div>`;

                  return `<tr class="hover:bg-slate-50/80 transition-all duration-300 group animate-fade-in opacity-0 block md:table-row bg-white md:bg-transparent border border-slate-200 md:border-none rounded-2xl md:rounded-none p-4 md:p-0" style="animation-delay: ${index * 50}ms;">
                    <td class="block md:table-cell px-0 md:px-5 py-2 md:py-3 border-b border-slate-100 md:border-none"><div class="font-medium text-slate-900 truncate max-w-xs" title="${Utils.escapeHTML(item.descricao)}">${Utils.escapeHTML(item.descricao)}</div><div class="flex items-center gap-2 mt-1">${trendHtml}<span class="text-[9px] text-slate-400 flex items-center gap-1 border-l border-slate-300 pl-2" title="Confiança da IA na precisão: ${confidence}%"><div class="w-1.5 h-1.5 rounded-full ${confColor}"></div>Confiança ${confText}</span></div></td>
                    <td class="flex justify-between items-center md:table-cell px-0 md:px-5 py-2 md:py-3 text-left md:text-right font-mono font-bold ${stockClass} border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase">Saldo</span><div class="flex flex-col items-end"><span>${Number(item.estoque) || 0} un</span><span class="text-[9px] text-slate-400 font-normal" title="Estoque de Segurança Sugerido pela IA">Buffer IA: ${safetyStock} un</span></div></td>
                    <td class="flex flex-col justify-center items-end md:items-center md:table-cell px-0 md:px-5 py-3 md:py-3 text-right md:text-center border-b border-slate-100 md:border-none"><div class="md:hidden font-bold text-[10px] text-slate-400 uppercase mb-1">Esgota Em</div>${prevText}</td>
                    <td class="flex flex-col items-end md:items-center justify-center md:table-cell px-0 md:px-5 py-3 md:py-3 border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase mb-1">Ação Sugerida</span><span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase border ${statusClass}">${statusText}</span>${suggHtml}</td>
                  </tr>`;
                })
                .join("") ||
              `<tr class="block md:table-row bg-white md:bg-transparent rounded-2xl md:rounded-none border border-slate-200 md:border-none"><td colspan="5" class="px-6 py-12 text-center text-slate-400 italic block md:table-cell">Tudo em ordem! Nenhum alerta.</td></tr>`
            }</tbody></table></div>
          </div>
          <div class="flex flex-col gap-6">
            <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col h-full relative">
              <h3 class="font-bold text-slate-900 mb-2 flex items-center gap-2"><i data-lucide="activity" class="w-5 h-5 text-blue-500"></i> Saúde do Estoque</h3>
              <div class="relative w-full h-64 md:h-48 mt-2 flex-1"><canvas id="statusChart"></canvas></div>
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
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col overflow-hidden w-full">
            <h3 class="font-bold text-slate-900 mb-4 flex items-center gap-2"><i data-lucide="bar-chart" class="w-5 h-5 text-brand-500"></i> ${this.dashboardCategory === "Todas" ? "Volume por Categoria" : "Top 10 Itens (Volume)"}</h3>
            <div class="relative w-full flex-1 overflow-x-auto custom-scrollbar pb-2"><div class="relative h-64 min-w-[400px] lg:min-w-0 lg:w-full"><canvas id="depositsChart"></canvas></div></div>
          </div>
          <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 p-5 flex flex-col overflow-hidden w-full">
            <h3 class="font-bold text-slate-900 mb-4 flex items-center gap-2"><i data-lucide="line-chart" class="w-5 h-5 text-purple-500"></i> Projeção e Consumo</h3>
            <div class="relative w-full flex-1 overflow-x-auto custom-scrollbar pb-2"><div class="relative h-64 min-w-[400px] lg:min-w-0 lg:w-full"><canvas id="monthlyChart"></canvas></div></div>
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
          <h3 ${valueId} class="text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight truncate" title="${displayValue}">${displayValue}</h3>
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

    const textColor = this.isDarkMode ? "#94a3b8" : "#64748b";
    const gridColor = this.isDarkMode ? "#334155" : "#f1f5f9";
    const tooltipBg = this.isDarkMode ? "#0f172a" : "#1e293b";

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
              position: window.innerWidth < 768 ? "bottom" : "right",
              labels: {
                usePointStyle: true,
                boxWidth: 8,
                font: { family: "Inter", size: 10 },
                color: textColor,
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
            backgroundColor: tooltipBg,
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
            grid: { color: gridColor, drawBorder: false },
            border: { display: false },
            ticks: { font: { family: "Inter", size: 10 }, color: textColor },
          },
          x: {
            grid: { display: false, drawBorder: false },
            border: { display: false },
            ticks: {
              font: { family: "Inter", size: 9 },
              color: textColor,
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
              labels: {
                usePointStyle: true,
                font: { family: "Inter" },
                color: textColor,
              },
            },
            tooltip: {
              backgroundColor: tooltipBg,
              padding: 14,
              titleFont: { size: 13, family: "Inter" },
              bodyFont: { size: 14, family: "Inter", weight: "bold" },
              displayColors: true,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: gridColor, drawBorder: false },
              border: { display: false },
              ticks: { font: { family: "Inter" }, color: textColor },
            },
            x: {
              grid: { display: false, drawBorder: false },
              border: { display: false },
              ticks: { font: { family: "Inter" }, color: textColor },
            },
          },
        },
      });
    }
  },
  renderMovementsLayout(title) {
    if (!AuthService.getCurrentUser()) return;
    const view = this.getOrCreateView("stock-move");
    const vid = "stock-move";

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
    if (view.innerHTML === "") {
      view.innerHTML = `
      <div class="space-y-4 h-full flex flex-col min-h-0 animate-fade-in max-w-[1600px] mx-auto pt-2">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-3xl border border-slate-200/60 shadow-sm z-10">
          <div class="flex flex-col sm:flex-row gap-3 w-full">
            <div class="relative group flex-1 md:flex-none"><i data-lucide="search" class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-brand-500 transition-colors"></i><input type="text" placeholder="Buscar código, nome..." autocomplete="off" value="${InventoryController.state.searchTerm}" oninput="InventoryController.handleSearch(this.value)" class="w-full md:w-72 pl-10 pr-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 text-sm bg-slate-50 focus:bg-white transition-all shadow-sm"></div>
            <div class="relative">
              <select id="filter-categoria" onchange="InventoryController.handleCategory(this.value)" class="appearance-none w-full md:w-64 bg-slate-50 border-0 ring-1 ring-slate-200 focus:bg-white text-slate-700 py-3 pl-4 pr-10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer shadow-sm transition-all">
                ${categories.map((cat) => `<option value="${cat}" ${InventoryController.state.categoryFilter === cat ? "selected" : ""}>${cat}</option>`).join("")}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-lucide="chevron-down" aria-hidden="true" class="lucide lucide-chevron-down w-4 h-4"><path d="m6 9 6 6 6-6"></path></svg></div>
            </div>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl shadow-none md:shadow-sm border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col min-h-0">
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
      lucide.createIcons();
    } else {
      const elGlobal = view.querySelector(
        'input[placeholder*="Buscar código"]',
      );
      if (elGlobal) elGlobal.value = InventoryController.state.searchTerm;
      const elCat = view.querySelector("#filter-categoria");
      if (elCat) elCat.value = InventoryController.state.categoryFilter;
    }
    this.renderTableRows();
  },
  renderTableRows() {
    const viewId =
      this.currentTab === "stock-favorites" ? "stock-search" : this.currentTab;
    const view = document.getElementById(`view-${viewId}`);
    if (!view) return;

    const tbody =
      view.querySelector("#inventory-body") || view.querySelector("tbody");
    if (!tbody) return;
    const { searchTerm, searchName, searchCode, categoryFilter, statusFilter } =
      InventoryController.state;
    const items = FirestoreService.items;
    const userFavs = FirestoreService.profile?.favorites || [];
    const isMovementTab = this.currentTab === "stock-move";
    const isStockSearchTab = this.currentTab === "stock-search";
    const isFavoritesTab = this.currentTab === "stock-favorites";
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
      if (isFavoritesTab && !userFavs.includes(String(item.id))) return false;

      const descNormalized = normalizeText(item.descricao);
      const codeNormalized = normalizeText(item.codigo);
      const internalCodeNormalized = normalizeText(item.codigoInterno);

      let matchesSearch = true;
      if (searchNormalized) {
        matchesSearch =
          descNormalized.includes(searchNormalized) ||
          codeNormalized.includes(searchNormalized) ||
          internalCodeNormalized.includes(searchNormalized);
      } else if (isStockSearchTab || isFavoritesTab) {
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
        !(isStockSearchTab || isFavoritesTab) ||
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

    // --- ORDENAÇÃO ---
    const sortCol = InventoryController.state.sortCol || "descricao";
    const sortDesc = InventoryController.state.sortDesc || false;

    uniqueItems.sort((a, b) => {
      let valA = a[sortCol];
      let valB = b[sortCol];

      if (["estoque", "estoqueMinimo", "qtdRessuprimento"].includes(sortCol)) {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      } else {
        valA = (valA || "").toString().toLowerCase();
        valB = (valB || "").toString().toLowerCase();
      }

      if (valA < valB) return sortDesc ? 1 : -1;
      if (valA > valB) return sortDesc ? -1 : 1;
      return 0;
    });

    InventoryController.state.currentExportData = uniqueItems;

    [
      "codigo",
      "codigoInterno",
      "descricao",
      "unidade",
      "estoque",
      "estoqueMinimo",
      "qtdRessuprimento",
    ].forEach((c) => {
      const el = view.querySelector("#sort-icon-" + viewId + "-" + c);
      if (el) {
        el.innerHTML =
          c === sortCol
            ? sortDesc
              ? '<i data-lucide="arrow-down" class="inline w-3 h-3 ml-1 text-brand-500"></i>'
              : '<i data-lucide="arrow-up" class="inline w-3 h-3 ml-1 text-brand-500"></i>'
            : "";
      }
    });

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
      tbody.innerHTML = `<tr><td colspan="${colSpan}" class="px-6 py-20 text-center flex flex-col items-center justify-center text-slate-400"><div class="bg-slate-50 p-4 rounded-full mb-3"><i data-lucide="${isFavoritesTab ? "star-off" : "search-x"}" class="w-8 h-8"></i></div><span class="font-medium">${isFavoritesTab ? "Nenhum item favorito ainda" : "Nenhum item encontrado"}</span><span class="text-xs mt-1">${isFavoritesTab ? "Clique na estrela ao lado de um material para salvá-lo aqui." : "Tente ajustar os filtros de busca"}</span></td></tr>`;
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
            let adminActions = "";
            if (AuthService.isAdmin()) {
              adminActions = `
                <button onclick="InventoryController.openEditModal('${item.id}')" class="p-2.5 md:p-1.5 text-amber-600 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl md:rounded-lg transition-all shadow-sm active:scale-95" title="Editar Material"><i data-lucide="edit" class="w-4 h-4 md:w-3.5 md:h-3.5"></i></button>
                <button onclick="InventoryController.deleteItem('${item.id}')" class="p-2.5 md:p-1.5 text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-xl md:rounded-lg transition-all shadow-sm active:scale-95" title="Excluir Material"><i data-lucide="trash-2" class="w-4 h-4 md:w-3.5 md:h-3.5"></i></button>
              `;
            }
            actionsCell = `<td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 text-center md:text-right mt-2 md:mt-0 border-t border-slate-100 md:border-none"><div class="flex items-center justify-center md:justify-end gap-2 md:opacity-80 group-hover:opacity-100 transition-opacity w-full">
              <button onclick="InventoryController.openStockDetailModal('${item.id}')" class="w-full md:w-auto flex justify-center items-center gap-2 p-2.5 md:p-1.5 text-brand-600 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-xl md:rounded-lg transition-all shadow-sm hover:shadow active:scale-95" title="Ver Detalhes"><i data-lucide="eye" class="w-4 h-4 md:w-3.5 md:h-3.5"></i><span class="md:hidden text-xs font-bold uppercase tracking-wider">Ver Detalhes</span></button>
              ${adminActions}
            </div></td>`;
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

          const isFav = userFavs.includes(String(item.id));
          const starIcon = isFav
            ? `<i data-lucide="star" class="w-4 h-4 fill-amber-400 text-amber-400"></i>`
            : `<i data-lucide="star" class="w-4 h-4 text-slate-300 group-hover:text-slate-400 transition-colors"></i>`;
          const starBtn = `<button onclick="FirestoreService.toggleFavorite('${item.id}')" class="float-left p-1 -ml-1 mr-1.5 mt-0.5 rounded-md hover:bg-slate-100 transition-colors focus:outline-none" title="${isFav ? "Remover dos Favoritos" : "Adicionar aos Favoritos"}">${starIcon}</button>`;

          return `<tr class="${rowClass}" style="animation-delay: ${Math.min(index * 30, 400)}ms;">
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Código</span><span class="font-mono text-xs text-slate-500">${Utils.escapeHTML(item.codigo)}</span></td>
            <td class="flex justify-between md:table-cell items-center px-0 py-2 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><span class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider">Cód. Int.</span><span class="font-mono text-xs text-slate-500">${Utils.escapeHTML(item.codigoInterno || "-")}</span></td>
            <td class="block md:table-cell px-0 py-3 md:px-4 md:py-4 border-b border-slate-100 md:border-none"><div class="md:hidden font-bold text-[10px] text-slate-400 uppercase tracking-wider mb-1">Descrição</div>${starBtn}<div class="font-semibold text-slate-800 text-sm mb-0.5">${Utils.escapeHTML(item.descricao)}</div><div class="text-[10px] text-slate-400 uppercase tracking-wide truncate max-w-full md:max-w-[200px]" title="${Utils.escapeHTML(catRaw || "-")}">${Utils.escapeHTML(catShort)}</div></td>
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

    const counter = view.querySelector("#total-records");
    if (counter) counter.innerText = totalItems;
    const pageSpan = view.querySelector("#current-page");
    if (pageSpan) pageSpan.innerText = InventoryController.state.currentPage;
    const totalPagesSpan = view.querySelector("#total-pages");
    if (totalPagesSpan) totalPagesSpan.innerText = totalPages;
    const btnPrev = view.querySelector("#btn-prev-page");
    if (btnPrev) btnPrev.disabled = InventoryController.state.currentPage === 1;
    const btnNext = view.querySelector("#btn-next-page");
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
  async handlePDFUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!AuthService.isAdmin()) {
      ToastManager.show("Sem permissão para importar dados.", "error");
      event.target.value = "";
      return;
    }

    if (!window.pdfjsLib) {
      ToastManager.show("Biblioteca de leitura de PDF não carregada.", "error");
      event.target.value = "";
      return;
    }

    const btnLabel = event.target.parentElement;
    const originalHTML = btnLabel.innerHTML;
    btnLabel.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin text-blue-500"></i> Lendo PDF...`;
    lucide.createIcons();

    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      const lines = {};
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        textContent.items.forEach((item) => {
          const y = Math.round(item.transform[5]); // Agrupa itens pela mesma altura (eixo Y)
          if (!lines[y]) lines[y] = [];
          lines[y].push(item);
        });
      }

      const sortedY = Object.keys(lines)
        .map(Number)
        .sort((a, b) => b - a);
      const parsedLines = sortedY.map((y) => {
        return lines[y]
          .sort((a, b) => a.transform[4] - b.transform[4])
          .map((item) => item.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      });

      let itemsToUpdate = new Map();
      const itemsMap = new Map();

      // Ordenar do maior nome para o menor para evitar matches parciais incorretos
      const sortedItems = [...FirestoreService.items].sort((a, b) => {
        const lenA = a.descricao ? a.descricao.length : 0;
        const lenB = b.descricao ? b.descricao.length : 0;
        return lenB - lenA;
      });

      sortedItems.forEach((i) => {
        if (i.descricao) itemsMap.set(i.descricao.trim().toUpperCase(), i);
      });

      parsedLines.forEach((line) => {
        let foundItem = null;
        const upperLine = line.toUpperCase();
        for (const [desc, item] of itemsMap.entries()) {
          if (upperLine.includes(desc)) {
            foundItem = item;
            break;
          }
        }

        if (foundItem) {
          // Extrai os últimos dois números da linha (Estoque e Custo)
          const numbers = line.match(/\b\d+(?:[.,]\d+)?\b/g);
          if (numbers && numbers.length >= 2) {
            const estoqueStr = numbers[numbers.length - 2].replace(",", ".");
            const custoStr = numbers[numbers.length - 1].replace(",", ".");
            const qty = parseFloat(estoqueStr);
            const custo = parseFloat(custoStr);

            if (!isNaN(qty) && !isNaN(custo)) {
              itemsToUpdate.set(foundItem.id, {
                id: foundItem.id,
                novoSaldo: qty,
                novoCusto: custo,
                codigo: foundItem.codigo,
                descricao: foundItem.descricao,
              });
            }
          }
        }
      });

      const updates = Array.from(itemsToUpdate.values());

      if (updates.length === 0) {
        ToastManager.show(
          "Nenhuma atualização encontrada. Verifique se o PDF contém o nome exato dos materiais.",
          "warning",
        );
      } else {
        if (
          !confirm(
            `O robô encontrou ${updates.length} atualizações de saldo ou custo neste PDF.\n\nConfirmar essas atualizações e salvar na nuvem?`,
          )
        ) {
          ToastManager.show(
            "Atualização via PDF cancelada pelo usuário.",
            "warning",
          );
          btnLabel.innerHTML = originalHTML;
          lucide.createIcons();
          event.target.value = "";
          return;
        }

        btnLabel.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin text-blue-500"></i> Salvando...`;
        lucide.createIcons();

        const writeInBatches = async (updatesArray) => {
          let changesCount = 0;
          for (let i = 0; i < updatesArray.length; i += 200) {
            const chunk = updatesArray.slice(i, i + 200);
            const batch = writeBatch(db);
            chunk.forEach((update) => {
              const currentItem = FirestoreService.items.find(
                (it) => String(it.id) === String(update.id),
              );
              const prevStock = currentItem
                ? Number(currentItem.estoque) || 0
                : 0;
              const prevCost = currentItem
                ? Number(currentItem.custoMedio) || 0
                : 0;
              const diff = update.novoSaldo - prevStock;
              const costDiff = update.novoCusto - prevCost;

              if (diff !== 0 || costDiff !== 0) {
                changesCount++;
                const docRef = doc(db, "items", String(update.id));
                const patch = {};
                if (diff !== 0) patch.estoque = update.novoSaldo;
                if (costDiff !== 0) patch.custoMedio = update.novoCusto;
                batch.update(docRef, patch);

                if (diff !== 0) {
                  const movRef = doc(collection(db, "movements"));
                  batch.set(movRef, {
                    itemId: update.id,
                    itemCodigo: update.codigo || "",
                    itemDesc: update.descricao || "",
                    type: diff > 0 ? "entrada" : "saida",
                    qty: Math.abs(diff),
                    reason: "Ajuste em lote via PDF",
                    previousStock: prevStock,
                    newStock: update.novoSaldo,
                    userName: AuthService.getCurrentUser()?.name || "Sistema",
                    date: serverTimestamp(),
                  });
                }
              }
            });
            await batch.commit();
          }
          return changesCount;
        };

        const changed = await writeInBatches(updates);
        if (changed > 0) {
          ToastManager.show(
            `Saldo de ${changed} materiais atualizados com sucesso!`,
            "success",
          );
          if (App.currentTab === "dashboard") App.renderDashboard();
          else App.refreshUI();
        } else {
          ToastManager.show(
            "Os saldos do PDF já são iguais aos do sistema.",
            "warning",
          );
        }
      }
    } catch (err) {
      console.error("Erro ao processar PDF:", err);
      ToastManager.show("Erro ao ler o arquivo PDF.", "error");
    } finally {
      btnLabel.innerHTML = originalHTML;
      lucide.createIcons();
      event.target.value = "";
    }
  },
  exportPDFUpdateTemplate() {
    const delimiter = ";";
    const header = ["MATERIAL", "SALDO", "CUSTO R$"].join(delimiter);

    const escapeCsv = (value) => {
      const str = value == null ? "" : String(value);
      return /["\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const rows = FirestoreService.items.map((item) => {
      return [item.descricao || "", item.estoque || 0, item.custoMedio || 0]
        .map(escapeCsv)
        .join(delimiter);
    });

    const csvContent = `\uFEFF${header}\n${rows.join("\n")}`;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `modelo_atualizacao_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  renderHistoryLayout() {
    const view = this.getOrCreateView("movement-search");
    const uniqueUsers = [
      ...new Set(
        (FirestoreService.movements || [])
          .map((m) => m.userName)
          .filter(Boolean),
      ),
    ].sort();

    if (view.innerHTML === "") {
      view.innerHTML = `
      <div class="space-y-4 h-full flex flex-col min-h-0 animate-fade-in max-w-7xl mx-auto pt-2">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-3xl border border-slate-200/60 shadow-sm z-10">
          <div class="flex flex-col sm:flex-row gap-3 w-full">
            <div class="relative group flex-1"><i data-lucide="search" class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-brand-500 transition-colors"></i><input type="text" id="search-history" autocomplete="off" placeholder="Buscar material, código..." oninput="App.renderHistoryTableRows()" class="w-full pl-10 pr-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 text-sm bg-slate-50 focus:bg-white transition-all shadow-sm"></div>
            <div class="relative">
              <select id="filter-user-history" onchange="App.renderHistoryTableRows()" class="appearance-none w-full sm:w-56 bg-slate-50 border-0 ring-1 ring-slate-200 focus:bg-white text-slate-700 py-3 pl-4 pr-10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer shadow-sm transition-all">
                <option value="">Todos os Usuários</option>
                ${uniqueUsers.map((u) => `<option value="${Utils.escapeHTML(u)}">${Utils.escapeHTML(u)}</option>`).join("")}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="m6 9 6 6 6-6"></path></svg></div>
            </div>
            <div class="flex gap-2 w-full sm:w-auto">
              <button onclick="App.printHistory()" class="flex-1 px-4 py-3 bg-slate-800 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-slate-900 transition-all flex items-center justify-center gap-2 active:scale-95" title="Imprimir Relatório"><i data-lucide="printer" class="w-4 h-4"></i> Imprimir</button>
              <button onclick="App.exportHistoryToCSV()" class="flex-1 px-4 py-3 bg-emerald-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar CSV"><i data-lucide="file-spreadsheet" class="w-4 h-4"></i> CSV</button>
              <button onclick="App.exportHistoryToPDF()" class="flex-1 px-4 py-3 bg-red-600 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-red-700 transition-all flex items-center justify-center gap-2 active:scale-95" title="Exportar PDF"><i data-lucide="file-text" class="w-4 h-4"></i> PDF</button>
            </div>
          </div>
        </div>
        <div class="bg-transparent md:bg-white rounded-3xl shadow-none md:shadow-sm border border-transparent md:border-slate-200/60 overflow-hidden flex-1 flex flex-col min-h-0">
          <div class="overflow-auto flex-1 custom-scrollbar">
            <table class="block md:table w-full text-sm text-left relative">
              <thead class="hidden md:table-header-group bg-slate-50/80 text-slate-500 font-bold uppercase text-[10px] tracking-widest sticky top-0 z-20 backdrop-blur-md border-b border-slate-200/80">
                <tr><th class="px-4 py-4 w-40 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="App.sortHistory('date')">Data/Hora <span id="sort-icon-hist-date"></span></th><th class="px-4 py-4 w-48 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="App.sortHistory('userName')">Usuário <span id="sort-icon-hist-userName"></span></th><th class="px-4 py-4 min-w-[200px] cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="App.sortHistory('itemDesc')">Material <span id="sort-icon-hist-itemDesc"></span></th><th class="px-4 py-4 text-center w-20 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="App.sortHistory('type')">Tipo <span id="sort-icon-hist-type"></span></th><th class="px-4 py-4 text-right w-20 cursor-pointer hover:text-brand-600 transition-colors select-none" onclick="App.sortHistory('qty')">Qtd <span id="sort-icon-hist-qty"></span></th><th class="px-4 py-4 text-right w-24">Saldo Ant.</th><th class="px-4 py-4 text-right w-24">Novo Saldo</th></tr>
              </thead>
              <tbody id="history-body" class="block md:table-row-group divide-y-0 md:divide-y divide-slate-100 bg-transparent md:bg-white space-y-4 md:space-y-0"></tbody>
            </table>
          </div>
        </div>
      </div>`;
      lucide.createIcons();
    }
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

    const sortCol = this.historySortCol || "date";
    const sortDesc = this.historySortDesc;

    filtered.sort((a, b) => {
      let valA = a[sortCol];
      let valB = b[sortCol];

      if (sortCol === "date") {
        valA = a.date?.toDate ? a.date.toDate().getTime() : 0;
        valB = b.date?.toDate ? b.date.toDate().getTime() : 0;
      } else if (sortCol === "qty") {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      } else {
        valA = (valA || "").toString().toLowerCase();
        valB = (valB || "").toString().toLowerCase();
      }

      if (valA < valB) return sortDesc ? 1 : -1;
      if (valA > valB) return sortDesc ? -1 : 1;
      return 0;
    });

    ["date", "userName", "itemDesc", "type", "qty"].forEach((c) => {
      const el = document.getElementById("sort-icon-hist-" + c);
      if (el) {
        el.innerHTML =
          c === sortCol
            ? sortDesc
              ? '<i data-lucide="arrow-down" class="inline w-3 h-3 ml-1 text-brand-500"></i>'
              : '<i data-lucide="arrow-up" class="inline w-3 h-3 ml-1 text-brand-500"></i>'
            : "";
      }
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
  exportHistoryToCSV() {
    const searchInput =
      document.getElementById("search-history")?.value.toLowerCase() || "";
    const userFilter =
      document.getElementById("filter-user-history")?.value || "";

    const filtered = (FirestoreService.movements || []).filter((mov) => {
      const matchStr = (
        (mov.itemDesc || "") +
        (mov.itemCodigo || "") +
        (mov.itemCodigoInterno || "") +
        (mov.userName || "")
      ).toLowerCase();
      const matchS = matchStr.includes(searchInput);
      const matchU = !userFilter || mov.userName === userFilter;
      return matchS && matchU;
    });

    if (filtered.length === 0)
      return ToastManager.show("Não há dados para exportar.", "warning");

    const delimiter = ";";
    const escapeCsv = (value) => {
      const str = value == null ? "" : String(value);
      return /["\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const header = [
      "Data/Hora",
      "Usuário",
      "Código",
      "Cód. Interno",
      "Material",
      "Tipo",
      "Qtd",
      "Motivo",
      "Saldo Anterior",
      "Novo Saldo",
    ].join(delimiter);

    const rows = filtered.map((mov) => {
      const dateStr = mov.date?.toDate
        ? mov.date.toDate().toLocaleString("pt-BR")
        : "-";
      return [
        dateStr,
        mov.userName || "-",
        mov.itemCodigo || "-",
        mov.itemCodigoInterno || "-",
        mov.itemDesc || "-",
        mov.type === "entrada" ? "Entrada" : "Saída",
        mov.qty || 0,
        mov.reason || "-",
        mov.previousStock !== undefined ? mov.previousStock : "-",
        mov.newStock !== undefined ? mov.newStock : "-",
      ]
        .map(escapeCsv)
        .join(delimiter);
    });

    const csvContent = `\uFEFF${header}\n${rows.join("\n")}`; // BOM para forçar UTF-8 no Excel
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria_movimentacoes_${new Date().getTime()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ToastManager.show("Relatório CSV gerado com sucesso!", "success");
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

    const tenantName = FirestoreService.profile?.tenantName || "Empresa";
    const pageWidth = doc.internal.pageSize.width;

    // Título Principal (Esquerda)
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59); // text-slate-800
    doc.text("SEROB", 14, 20);

    // Título Secundário (Direita)
    doc.setFontSize(14);
    doc.text("Auditoria e Histórico de Sistema", pageWidth - 14, 18, {
      align: "right",
    });

    // Subtítulo dinâmico (Direita)
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139); // text-slate-500
    doc.text(
      `Emissão: ${new Date().toLocaleString("pt-BR")} | Empresa: ${tenantName}`,
      pageWidth - 14,
      24,
      { align: "right" },
    );

    // Linha divisória fina cinza
    doc.setDrawColor(226, 232, 240); // border-slate-200
    doc.setLineWidth(0.5);
    doc.line(14, 28, pageWidth - 14, 28);

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
      startY: 34,
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

    const pageCount = doc.internal.getNumberOfPages();
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.text(
        `Página ${i} de ${pageCount}`,
        pageWidth - 14,
        doc.internal.pageSize.height - 10,
        { align: "right" },
      );
    }

    doc.save(`auditoria_movimentacoes_${new Date().getTime()}.pdf`);
    ToastManager.show("Relatório PDF gerado com sucesso!", "success");
  },
  printHistory() {
    const searchInput =
      document.getElementById("search-history")?.value.toLowerCase() || "";
    const userFilter =
      document.getElementById("filter-user-history")?.value || "";

    const filtered = (FirestoreService.movements || []).filter((mov) => {
      const matchStr = (
        (mov.itemDesc || "") +
        (mov.itemCodigo || "") +
        (mov.itemCodigoInterno || "") +
        (mov.userName || "")
      ).toLowerCase();
      const matchS = matchStr.includes(searchInput);
      const matchU = !userFilter || mov.userName === userFilter;
      return matchS && matchU;
    });

    if (filtered.length === 0)
      return ToastManager.show("Não há dados para imprimir.", "warning");

    const printWindow = window.open("", "_blank");
    const tenantName = Utils.escapeHTML(
      FirestoreService.profile?.tenantName || "Empresa",
    );
    let html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <title>Relatório de Movimentações</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
          .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #e2e8f0; padding-bottom: 15px; margin-bottom: 20px; }
          .logo-container { display: flex; align-items: center; gap: 10px; }
          /* Caso queira usar a logo da sua empresa em formato de imagem, troque o SVG abaixo por <img src="URL_DA_SUA_IMAGEM" style="max-width: 150px;"/> */
          .logo-container svg { width: 36px; height: 36px; fill: #2563eb; }
          .logo-container h1 { margin: 0; font-size: 24px; color: #1e293b; letter-spacing: -0.5px; font-weight: 800; }
          .title-container { text-align: right; }
          .title-container h2 { margin: 0 0 4px 0; color: #1e293b; font-size: 16px; font-weight: bold; }
          .subtitle { color: #64748b; font-size: 12px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
          th { background-color: #f8fafc; color: #475569; font-weight: bold; }
          .center { text-align: center; }
          .right { text-align: right; }
          @media print {
            @page { margin: 1cm; }
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo-container">
            <svg viewBox="0 0 101.968 101.968">
              <path d="M24.715,47.432L7.968,64.86v29.406c0,0.828,0.671,1.5,1.5,1.5h20.334c0.828,0,1.5-0.672,1.5-1.5V49.158l-4.69-1.726H24.715z"/>
              <path d="M66.135,61.1H45.801c-0.828,0-1.5,0.672-1.5,1.5v31.666c0,0.828,0.672,1.5,1.5,1.5h20.334c0.829,0,1.5-0.672,1.5-1.5V62.6C67.635,61.772,66.964,61.1,66.135,61.1z"/>
              <path d="M101.724,29.49c-0.777,0.406-1.652,0.621-2.53,0.621c-1.276,0-2.521-0.45-3.5-1.27l-3.694-3.088l-13.365,14.58v53.934c0,0.828,0.672,1.5,1.5,1.5h20.334c0.829,0,1.5-0.672,1.5-1.5v-64.93C101.885,29.387,101.81,29.445,101.724,29.49z"/>
              <path d="M57.797,54.094c1.144,0.419,2.424,0.108,3.248-0.788l30.839-33.643l7.217,6.032c0.353,0.294,0.847,0.349,1.254,0.136c0.407-0.214,0.646-0.648,0.605-1.107L99.396,7.235c-0.055-0.625-0.606-1.086-1.231-1.029l-17.49,1.563c-0.458,0.041-0.846,0.354-0.982,0.791C79.646,8.706,79.631,8.854,79.644,9c0.026,0.294,0.167,0.572,0.403,0.769l7.229,6.043L57.98,47.769L24.535,35.463c-1.118-0.41-2.373-0.121-3.198,0.735l-20.5,21.333c-1.148,1.195-1.11,3.095,0.084,4.242c0.583,0.561,1.332,0.837,2.079,0.837c0.788,0,1.574-0.309,2.164-0.921l19.141-19.92L57.797,54.094z"/>
            </svg>
            <h1>SEROB</h1>
          </div>
          <div class="title-container">
            <h2>Auditoria e Histórico de Sistema</h2>
            <div class="subtitle">Emissão: ${new Date().toLocaleString("pt-BR")} | Empresa: <strong>${tenantName}</strong></div>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Data/Hora</th><th>Usuário</th><th>Código</th><th>Cód. Int.</th><th>Material</th><th class="center">Tipo</th><th class="right">Qtd</th><th>Motivo</th></tr>
          </thead>
          <tbody>
    `;

    filtered.forEach((mov) => {
      const dateStr = mov.date?.toDate
        ? mov.date.toDate().toLocaleString("pt-BR")
        : "-";
      const tipo = mov.type === "entrada" ? "Entrada" : "Saída";
      html += `<tr><td>${dateStr}</td><td>${Utils.escapeHTML(mov.userName || "-")}</td><td>${Utils.escapeHTML(mov.itemCodigo || "-")}</td><td>${Utils.escapeHTML(mov.itemCodigoInterno || "-")}</td><td>${Utils.escapeHTML(mov.itemDesc || "-")}</td><td class="center">${tipo}</td><td class="right">${mov.qty || 0}</td><td>${Utils.escapeHTML(mov.reason || "-")}</td></tr>`;
    });

    html += `
          </tbody>
        </table>
        <script>
          window.onload = function() { setTimeout(function() { window.print(); window.close(); }, 250); };
        </script>
      </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
  },
  renderRegisterLayout() {
    const view = this.getOrCreateView("material-register");
    if (view.innerHTML === "") {
      view.innerHTML = `
      <div class="max-w-3xl mx-auto animate-fade-in pt-4">
        <div class="bg-white rounded-3xl shadow-lg shadow-slate-200/40 border border-slate-200/60 p-8 md:p-10 relative overflow-hidden">
          <div class="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-brand-500 to-indigo-500"></div>
          <form onsubmit="InventoryController.saveNewItem(event)" class="space-y-5">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
<div>
  <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Descrição do Material</label>
  <input type="text" id="new-descricao" list="lista-descricoes" onchange="InventoryController.handleDescricaoAutoFill()" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" placeholder="Nome completo do item" required />
  <datalist id="lista-descricoes">
    ${[...new Set((FirestoreService.items || []).map((i) => i.descricao).filter(Boolean))].map((desc) => `<option value="${Utils.escapeHTML(desc)}"></option>`).join("")}
  </datalist>
</div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Cód. Interno</label><input type="text" id="new-codigo-interno" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm font-mono text-sm" placeholder="Ex: 12345" required oninput="InventoryController.handleCodigoInternoAutoFill()" /></div>
            </div>
            <div class="grid grid-cols-2 gap-6">
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Categoria</label><select id="new-categoria" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" required></select></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Unidade</label><input type="text" id="new-unidade" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm" placeholder="Ex: Unidade" required /></div>
            </div>
            <div class="grid grid-cols-3 gap-6 border-t border-slate-100 pt-6 mt-2">
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Estoque Inicial</label><input type="number" id="new-estoque" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="0" /></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Mínimo</label><input type="number" id="new-minimo" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="5" /></div>
              <div><label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 ml-1">Ressuprimento</label><input type="number" id="new-ressup" class="w-full px-4 py-3 border-0 ring-1 ring-slate-200 rounded-2xl focus:ring-2 focus:ring-brand-500 outline-none transition-all bg-slate-50 focus:bg-white shadow-sm text-sm font-mono" value="10" /></div>
            </div>
            <div class="flex justify-end pt-6"><button type="submit" class="px-8 py-3 bg-brand-600 text-white text-sm font-bold rounded-2xl shadow-lg shadow-brand-600/30 hover:bg-brand-700 transition-all transform active:scale-95 flex items-center gap-2"><i data-lucide="check" class="w-5 h-5"></i> Salvar Material</button></div>
          </form>
        </div>
      </div>`;
      lucide.createIcons();
      this.renderDepositOptions();
    }
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
  async toggleUserStatus(uid, currentStatus) {
    if (
      !confirm(
        `Tem certeza que deseja ${currentStatus ? "desativar" : "ativar"} o acesso deste usuário?`,
      )
    )
      return;
    try {
      const newStatus = await FirestoreService.toggleUserStatus(
        uid,
        currentStatus,
      );
      ToastManager.show(
        `Usuário ${newStatus ? "ativado" : "desativado"} com sucesso!`,
        "success",
      );
      // Força o recarregamento visual da tabela
      const view = document.getElementById("view-saas-admin");
      if (view) view.innerHTML = "";
      this.renderSaaSAdmin();
    } catch (e) {
      console.error(e);
      ToastManager.show("Erro ao alterar status do usuário.", "error");
    }
  },
  async renderSaaSAdmin() {
    const view = this.getOrCreateView("saas-admin");
    if (view.innerHTML === "") {
      view.innerHTML = `<div class="p-12 text-center flex flex-col items-center justify-center"><i data-lucide="loader" class="w-8 h-8 animate-spin text-brand-500 mb-4"></i><span class="text-slate-500 font-medium">Carregando dados do painel...</span></div>`;
      lucide.createIcons();
    }

    try {
      const usersList = await FirestoreService.getUsers();

      view.innerHTML = `
      <div class="space-y-6 animate-fade-in max-w-7xl mx-auto pt-4">
        <div class="bg-gradient-to-r from-slate-900 to-slate-800 rounded-3xl p-8 shadow-xl text-white relative overflow-hidden">
           <div class="absolute top-0 right-0 opacity-10 pointer-events-none transform translate-x-1/4 -translate-y-1/4"><i data-lucide="shield-check" class="w-64 h-64"></i></div>
           <div class="relative z-10">
              <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold uppercase tracking-wider mb-4 border border-purple-500/30"><i data-lucide="crown" class="w-3.5 h-3.5"></i> Super Admin</div>
              <h2 class="text-3xl font-extrabold tracking-tight mb-2">Painel de Gestão Multiempresa</h2>
              <p class="text-slate-400">Controle total sobre contas de usuários, acessos e métricas globais do SaaS.</p>
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
              <h3 class="text-4xl font-extrabold text-slate-800">${usersList.length}</h3>
           </div>
           <div class="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60">
              <div class="w-10 h-10 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center mb-4"><i data-lucide="credit-card" class="w-5 h-5"></i></div>
              <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">MRR (Faturamento Mock)</p>
              <h3 class="text-4xl font-extrabold text-slate-800">R$ 97<span class="text-base text-slate-400 font-medium">/mês</span></h3>
           </div>
        </div>
        
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden mt-6">
           <div class="p-6 border-b border-slate-100"><h3 class="font-bold text-slate-800">Gerenciamento de Usuários</h3></div>
           <div class="overflow-x-auto">
             <table class="w-full text-left text-sm whitespace-nowrap">
               <thead class="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-wider"><tr><th class="px-6 py-4">Nome</th><th class="px-6 py-4">Email</th><th class="px-6 py-4">Empresa</th><th class="px-6 py-4">Função</th><th class="px-6 py-4 text-center">Status</th><th class="px-6 py-4 text-right">Ação</th></tr></thead>
               <tbody class="divide-y divide-slate-100">
                  ${usersList
                    .map((u) => {
                      const isActive = u.active !== false;
                      const statusHtml = isActive
                        ? '<span class="px-2 py-1 rounded bg-emerald-100 text-emerald-700 text-xs font-bold uppercase tracking-wider">Ativo</span>'
                        : '<span class="px-2 py-1 rounded bg-red-100 text-red-700 text-xs font-bold uppercase tracking-wider">Inativo</span>';
                      const actionText = isActive
                        ? "Desativar Conta"
                        : "Reativar Conta";
                      const actionClass = isActive
                        ? "text-red-600 hover:text-red-800"
                        : "text-emerald-600 hover:text-emerald-800";
                      const isSelf =
                        u.uid === AuthService.getCurrentUser()?.uid;
                      const actionBtn = isSelf
                        ? '<span class="text-slate-400 text-xs italic font-medium px-2">Você</span>'
                        : `<button onclick="App.toggleUserStatus('${u.uid}', ${isActive})" class="font-bold text-xs px-3 py-1.5 rounded-lg border border-transparent hover:border-current transition-all active:scale-95 ${actionClass}">${actionText}</button>`;
                      const roleLabel =
                        u.label ||
                        (u.role === "admin" ? "Administrador" : "Usuário");

                      return `<tr class="hover:bg-slate-50 transition-colors"><td class="px-6 py-4 font-semibold text-slate-800">${Utils.escapeHTML(u.name || "Sem nome")}</td><td class="px-6 py-4 text-slate-500">${Utils.escapeHTML(u.email || "-")}</td><td class="px-6 py-4 text-slate-500">${Utils.escapeHTML(u.tenantName || "-")}</td><td class="px-6 py-4 text-slate-500 capitalize">${Utils.escapeHTML(roleLabel)}</td><td class="px-6 py-4 text-center">${statusHtml}</td><td class="px-6 py-4 text-right">${actionBtn}</td></tr>`;
                    })
                    .join("")}
               </tbody>
             </table>
           </div>
        </div>
      </div>`;
      lucide.createIcons();
    } catch (error) {
      console.error("Erro ao carregar SaaS Admin:", error);
      view.innerHTML = `<div class="p-8 text-center text-red-500">Erro ao carregar dados do painel de administração. Verifique sua conexão.</div>`;
    }
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
