"""دفتر مهلة — موقع مستقل: الشركاء ورؤوس أموالهم، وعملاء كل شريك، والسداد.

الأدوار:
  admin   صاحب الدفتر: يرى كل شيء ويعدّل كل شيء.
  partner الشريك: يطّلع على صفحته وعملائه فقط، ولا يعدّل شيئًا.
"""
import json
import os
import secrets
import time
from datetime import timedelta
from functools import wraps

from flask import (Flask, Response, abort, jsonify, redirect, render_template, request,
                   session, url_for)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
db = SQLAlchemy()

DEFAULT_RATE = 14.0
MAX_BOND_BYTES = 6 * 1024 * 1024
BOND_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"}


# ---------------------------------------------------------------- models
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # admin | partner
    partner_id = db.Column(db.Integer, db.ForeignKey("partner.id"), nullable=True)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)


class Partner(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), default="")
    capital = db.Column(db.Float, nullable=True)
    order = db.Column(db.Integer, default=0)


class Client(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    partner_id = db.Column(db.Integer, db.ForeignKey("partner.id"), nullable=False, index=True)
    slot = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(160), default="")
    nid = db.Column(db.String(40), default="")
    taken = db.Column(db.Float, nullable=True)
    due = db.Column(db.Float, nullable=True)
    rate = db.Column(db.Float, nullable=True)
    phone = db.Column(db.String(40), default="")
    paid = db.Column(db.Boolean, default=False)
    bond = db.deferred(db.Column(db.LargeBinary, nullable=True))
    bond_type = db.Column(db.String(60), nullable=True)
    __table_args__ = (db.UniqueConstraint("partner_id", "slot"),)


class Setting(db.Model):
    key = db.Column(db.String(60), primary_key=True)
    value = db.Column(db.Text)


def get_rate():
    s = db.session.get(Setting, "rate")
    try:
        return float(s.value) if s else DEFAULT_RATE
    except (TypeError, ValueError):
        return DEFAULT_RATE


DEFAULT_SHARE = 50.0  # نصيب الشريك من الربح، والباقي للتشغيل


def get_share():
    s = db.session.get(Setting, "share")
    try:
        v = float(s.value) if s else DEFAULT_SHARE
        return v if 0 <= v <= 100 else DEFAULT_SHARE
    except (TypeError, ValueError):
        return DEFAULT_SHARE


def due_of(taken, rate):
    if taken is None:
        return None
    return round(taken * (1 + rate / 100), 2)


# ---------------------------------------------------------------- app
def _local_secret():
    path = os.path.join(BASE, ".secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


def create_app():
    app = Flask(__name__)
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or _local_secret()
    url = os.environ.get("DATABASE_URL", "sqlite:///" + os.path.join(BASE, "mohla.db"))
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
    app.config["SQLALCHEMY_DATABASE_URI"] = url
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = bool(os.environ.get("RENDER"))
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BOND_BYTES + 512 * 1024
    db.init_app(app)
    with app.app_context():
        db.create_all()
        ensure_admin()
    register(app)
    return app


def ensure_admin():
    if User.query.filter_by(role="admin").first():
        return
    pw = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(9)
    if not os.environ.get("ADMIN_PASSWORD"):
        print(f"*** admin password: {pw} ***", flush=True)
    u = User(username="admin", role="admin")
    u.set_password(pw)
    db.session.add(u)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()


# ---------------------------------------------------------------- helpers
def current_user():
    uid = session.get("uid")
    return db.session.get(User, uid) if uid else None


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return session["csrf"]


def login_required(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                if request.path.startswith("/api/"):
                    return jsonify(error="login"), 401
                return redirect(url_for("login"))
            if role and u.role != role:
                abort(403)
            if request.method in ("POST", "PUT", "DELETE"):
                if request.headers.get("X-CSRF") != session.get("csrf") and \
                        request.form.get("_csrf") != session.get("csrf"):
                    abort(400)
            request.user = u
            return fn(*a, **kw)
        return wrapper
    return deco


def num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        abort(400)
    if f < 0 or f > 1e10:
        abort(400)
    return f


def text(v, n):
    return ("" if v is None else str(v)).strip()[:n]


def client_json(c):
    return {"slot": c.slot, "name": c.name or "", "nid": c.nid or "", "taken": c.taken, "due": c.due,
            "rate": c.rate, "phone": c.phone or "", "paid": bool(c.paid), "bond": c.id if c.bond_type else None,
            "bondType": c.bond_type or ""}


# ---------------------------------------------------------------- routes
def register(app):
    @app.route("/healthz")
    def healthz():
        return "ok"

    @app.route("/login", methods=["GET", "POST"])
    def login():
        err = None
        if request.method == "POST":
            u = User.query.filter_by(username=text(request.form.get("username"), 80).lower()).first()
            if u and u.check_password(request.form.get("password") or ""):
                session.clear()
                session.permanent = True
                session["uid"] = u.id
                return redirect(url_for("home"))
            time.sleep(1)  # يبطّئ تخمين كلمات المرور
            err = "اسم المستخدم أو كلمة المرور غير صحيحة"
        return render_template("login.html", err=err)

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.route("/")
    @login_required()
    def home():
        u = request.user
        return render_template("app.html", csrf=csrf_token(), role=u.role, username=u.username)

    # ---- state
    @app.route("/api/state")
    @login_required()
    def state():
        u = request.user
        if u.role == "admin":
            partners = Partner.query.all()
        else:
            partners = [db.session.get(Partner, u.partner_id)] if u.partner_id else []
            partners = [p for p in partners if p]
        partners.sort(key=lambda p: (-(p.capital or 0), p.order or 0, p.id))  # الأعلى رأس مال أولًا
        ids = [p.id for p in partners]
        accounts = {x.partner_id: x.username for x in User.query.filter(User.partner_id.in_(ids))} if ids else {}
        clients = {}
        if ids:
            for c in Client.query.filter(Client.partner_id.in_(ids)).order_by(Client.slot):
                clients.setdefault(str(c.partner_id), []).append(client_json(c))
        return jsonify(
            role=u.role, username=u.username, rate=get_rate(), share=get_share(),
            partners=[{"id": p.id, "name": p.name or "", "capital": p.capital, "order": p.order,
                       "account": accounts.get(p.id) if u.role == "admin" else None} for p in partners],
            clients=clients)

    # ---- partners (admin)
    @app.route("/api/partner", methods=["POST"])
    @login_required("admin")
    def partner_add():
        top = db.session.query(db.func.max(Partner.order)).scalar() or 0
        p = Partner(name=text((request.json or {}).get("name"), 120), order=top + 1)
        db.session.add(p)
        db.session.commit()
        return jsonify(id=p.id)

    @app.route("/api/partner/<int:pid>", methods=["PUT", "DELETE"])
    @login_required("admin")
    def partner_edit(pid):
        p = db.session.get(Partner, pid) or abort(404)
        if request.method == "DELETE":
            Client.query.filter_by(partner_id=pid).delete()
            User.query.filter_by(partner_id=pid, role="partner").delete()
            db.session.delete(p)
            db.session.commit()
            return jsonify(ok=True)
        d = request.json or {}
        if "name" in d:
            p.name = text(d["name"], 120)
        if "capital" in d:
            p.capital = num(d["capital"])
        db.session.commit()
        return jsonify(ok=True)

    @app.route("/api/partner/<int:pid>/account", methods=["POST", "DELETE"])
    @login_required("admin")
    def partner_account(pid):
        p = db.session.get(Partner, pid) or abort(404)
        u = User.query.filter_by(partner_id=pid, role="partner").first()
        if request.method == "DELETE":
            if u:
                db.session.delete(u)
                db.session.commit()
            return jsonify(ok=True)
        name = text((request.json or {}).get("username"), 40).lower()
        if not name or not all(ch.isalnum() or ch in "._-" for ch in name):
            return jsonify(error="اسم المستخدم يكون بحروف إنجليزية أو أرقام فقط"), 400
        other = User.query.filter_by(username=name).first()
        if other and (not u or other.id != u.id):
            return jsonify(error="اسم المستخدم مستخدم من قبل"), 400
        pw = ((request.json or {}).get("password") or "").strip()
        if pw and len(pw) < 6:
            return jsonify(error="كلمة المرور 6 أحرف أو أرقام على الأقل"), 400
        if not pw:  # إذا تركها فارغة تُنشأ تلقائيًا
            alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
            pw = "".join(secrets.choice(alphabet) for _ in range(8))
        if not u:
            u = User(role="partner", partner_id=p.id, username=name)
            db.session.add(u)
        u.username = name
        u.set_password(pw)
        db.session.commit()
        return jsonify(username=name, password=pw)

    # ---- clients (admin)
    @app.route("/api/client/<int:pid>/<int:slot>", methods=["PUT"])
    @login_required("admin")
    def client_edit(pid, slot):
        if not db.session.get(Partner, pid) or slot < 1 or slot > 5000:
            abort(404)
        c = Client.query.filter_by(partner_id=pid, slot=slot).first()
        if not c:
            c = Client(partner_id=pid, slot=slot)
            db.session.add(c)
        d = request.json or {}
        for f, n in (("name", 160), ("nid", 40), ("phone", 40)):
            if f in d:
                setattr(c, f, text(d[f], n))
        if "paid" in d:
            c.paid = bool(d["paid"])
        if "taken" in d:
            c.taken = num(d["taken"])
            r = get_rate()
            c.rate = r if c.taken is not None else None
            c.due = due_of(c.taken, r)
        db.session.commit()
        return jsonify(client_json(c))

    @app.route("/api/client/<int:pid>", methods=["POST"])
    @login_required("admin")
    def client_new(pid):
        if not db.session.get(Partner, pid):
            abort(404)
        d = request.json or {}
        top = db.session.query(db.func.max(Client.slot)).filter(Client.partner_id == pid).scalar() or 0
        c = Client(partner_id=pid, slot=top + 1, name=text(d.get("name"), 160), nid=text(d.get("nid"), 40),
                   phone=text(d.get("phone"), 40), paid=False)
        c.taken = num(d.get("taken"))
        if c.taken is not None:
            c.rate = get_rate()
            c.due = due_of(c.taken, c.rate)
        db.session.add(c)
        db.session.commit()
        return jsonify(client_json(c))

    @app.route("/api/client/<int:pid>/<int:slot>/bond", methods=["POST"])
    @login_required("admin")
    def client_bond(pid, slot):
        if not db.session.get(Partner, pid):
            abort(404)
        f = request.files.get("file")
        if not f:
            return jsonify(error="لم يصل الملف"), 400
        data = f.read()
        ctype = (f.mimetype or "").lower()
        if ctype not in BOND_TYPES:
            return jsonify(error="ارفع صورة أو ملف PDF"), 400
        if len(data) > MAX_BOND_BYTES:
            return jsonify(error="الملف أكبر من 6 ميجابايت"), 400
        c = Client.query.filter_by(partner_id=pid, slot=slot).first()
        if not c:
            c = Client(partner_id=pid, slot=slot)
            db.session.add(c)
        c.bond, c.bond_type = data, ctype
        db.session.commit()
        return jsonify(client_json(c))

    @app.route("/bond/<int:cid>")
    @login_required()
    def bond(cid):
        c = db.session.get(Client, cid) or abort(404)
        u = request.user
        if u.role != "admin" and c.partner_id != u.partner_id:
            abort(404)
        if not c.bond:
            abort(404)
        resp = Response(c.bond, mimetype=c.bond_type or "application/octet-stream")
        resp.headers["Cache-Control"] = "private, max-age=86400"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Content-Disposition"] = "inline"
        return resp

    # ---- rate (admin)
    @app.route("/api/rate", methods=["PUT"])
    @login_required("admin")
    def rate_set():
        r = num((request.json or {}).get("rate"))
        if r is None or r > 1000:
            abort(400)
        s = db.session.get(Setting, "rate") or Setting(key="rate")
        s.value = str(r)
        db.session.merge(s)
        db.session.commit()
        return jsonify(rate=r)

    @app.route("/api/share", methods=["PUT"])
    @login_required("admin")
    def share_set():
        v = num((request.json or {}).get("share"))
        if v is None or v > 100:
            abort(400)
        db.session.merge(Setting(key="share", value=str(v)))
        db.session.commit()
        return jsonify(share=v)

    @app.route("/api/rate/apply", methods=["POST"])
    @login_required("admin")
    def rate_apply():
        r = get_rate()
        n = 0
        q = Client.query.filter(Client.taken.isnot(None))
        pid = (request.get_json(silent=True) or {}).get("partner_id")
        if pid:
            q = q.filter(Client.partner_id == int(pid))
        for c in q:
            d = due_of(c.taken, r)
            if c.due != d or c.rate != r:
                c.due, c.rate = d, r
                n += 1
        db.session.commit()
        return jsonify(changed=n, rate=r)

    # ---- import from the old ledger (admin)
    @app.route("/api/import", methods=["POST"])
    @login_required("admin")
    def import_data():
        try:
            d = json.loads(request.json.get("data") if request.is_json else request.get_data(as_text=True))
        except Exception:
            return jsonify(error="النص غير صالح"), 400
        made = 0
        for i, pd in enumerate(d.get("partners", []), 1):
            p = Partner(name=text(pd.get("name"), 120), capital=num(pd.get("capital")), order=pd.get("order") or i)
            db.session.add(p)
            db.session.flush()
            for cd in pd.get("clients", []):
                taken = num(cd.get("taken"))
                db.session.add(Client(partner_id=p.id, slot=int(cd.get("slot") or 0) or 1,
                                      name=text(cd.get("name"), 160), nid=text(cd.get("nid"), 40),
                                      phone=text(cd.get("phone"), 40), taken=taken,
                                      due=num(cd.get("due")), rate=num(cd.get("rate")),
                                      paid=bool(cd.get("paid"))))
            made += 1
        if d.get("rate") is not None:
            db.session.merge(Setting(key="rate", value=str(num(d["rate"]))))
        db.session.commit()
        return jsonify(partners=made)

    # ---- own password
    @app.route("/api/password", methods=["POST"])
    @login_required()
    def password():
        d = request.json or {}
        u = request.user
        if not u.check_password(d.get("old") or ""):
            return jsonify(error="كلمة المرور الحالية غير صحيحة"), 400
        new = d.get("new") or ""
        if len(new) < 6:
            return jsonify(error="كلمة المرور الجديدة 6 أحرف على الأقل"), 400
        u.set_password(new)
        db.session.commit()
        return jsonify(ok=True)

    @app.after_request
    def headers(resp):
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp


app = create_app()
