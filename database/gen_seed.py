import random

random.seed(42)

# 26 barangays of Sta. Cruz, Laguna with approximate demo coordinates
# spread across the municipality (not surveyed GIS points -- this is
# seed/demo data -- but laid out so the poblacion cluster sits central,
# the lakeside barangays sit north, and the barangays the town's own
# geology notes as "eastern portion" (Alipit, San Jose, Oogong, Jasaan,
# San Juan, Palasan, and portions of Pagsawitan, Patimbao, Bubukal,
# Labuin, Malinao) sit toward higher longitude).
BARANGAYS = [
    ("Poblacion I",          14.2800, 121.4130),
    ("Poblacion II",         14.2815, 121.4145),
    ("Poblacion III",        14.2825, 121.4160),
    ("Poblacion IV",         14.2795, 121.4175),
    ("Poblacion V",          14.2780, 121.4155),
    ("Bagumbayan",           14.2840, 121.4120),
    ("Santisima Cruz",       14.2870, 121.4100),
    ("Santo Angel Central",  14.2890, 121.4130),
    ("Santo Angel Norte",    14.2915, 121.4145),
    ("Santo Angel Sur",      14.2860, 121.4165),
    ("San Pablo Norte",      14.2940, 121.4110),
    ("San Pablo Sur",        14.2905, 121.4085),
    ("Bubukal",              14.2735, 121.4055),
    ("Calios",               14.2901, 121.4211),
    ("Duhat",                14.2760, 121.4225),
    ("Gatid",                14.2700, 121.4190),
    ("Jasaan",               14.2650, 121.4290),
    ("Labuin",               14.2680, 121.4160),
    ("Malinao",              14.2620, 121.4230),
    ("Oogong",               14.2600, 121.4320),
    ("Pagsawitan",           14.2745, 121.4280),
    ("Palasan",              14.2560, 121.4260),
    ("Patimbao",             14.2690, 121.4340),
    ("San Jose",             14.2530, 121.4300),
    ("San Juan",             14.2585, 121.4370),
    ("Alipit",               14.2480, 121.4230),
]
assert len(BARANGAYS) == 26

def abbrev(name):
    parts = name.replace(".", "").split()
    if len(parts) == 1:
        return parts[0][:3].upper()
    if parts[0] in ("Poblacion",):
        return "POB" + parts[1]  # e.g. POBI, POBII
    if parts[0] in ("Santo", "Santa", "Santisima", "San"):
        return "".join(p[0] for p in parts).upper() + parts[-1][:1].upper()
    return (parts[0][:2] + parts[-1][:1]).upper()

# Make codes unique & short by hand (clearer than the heuristic above
# for a couple of ambiguous cases).
CODE_OVERRIDES = {
    "Poblacion I": "POB1", "Poblacion II": "POB2", "Poblacion III": "POB3",
    "Poblacion IV": "POB4", "Poblacion V": "POB5",
    "Santo Angel Central": "SAC", "Santo Angel Norte": "SAN1", "Santo Angel Sur": "SAS",
    "San Pablo Norte": "SPN", "San Pablo Sur": "SPS",
    "Santisima Cruz": "SSC", "San Jose": "SJO", "San Juan": "SJN",
    "Bagumbayan": "BGB", "Bubukal": "BUB", "Calios": "CAL", "Duhat": "DUH",
    "Gatid": "GAT", "Jasaan": "JAS", "Labuin": "LAB", "Malinao": "MAL",
    "Oogong": "OOG", "Pagsawitan": "PAG", "Palasan": "PAL", "Patimbao": "PAT",
    "Alipit": "ALP",
}
for name, _, _ in BARANGAYS:
    assert name in CODE_OVERRIDES, name

FIRST_NAMES = [
    "Juan","Maria","Jose","Ana","Pedro","Rosa","Antonio","Carmen","Miguel","Teresa",
    "Ramon","Carla","Julius","Liza","Marco","Paolo","Ricardo","Elena","Fernando","Grace",
    "Danilo","Josefina","Roberto","Cristina","Eduardo","Angelica","Vicente","Luz","Benjamin","Precious",
    "Arnel","Divina","Noel","Emily","Rodrigo","Marites","Renato","Susan","Alfredo","Jocelyn",
    "Cesar","Leonor","Bayani","Corazon","Gerardo","Imelda","Hernan","Fe","Isagani","Nenita",
]
LAST_NAMES = [
    "Dela Cruz","Reyes","Santos","Bautista","Mendoza","Ramos","Aquino","Villanueva","Fernandez","Garcia",
    "Torres","Flores","Gonzales","Castillo","Rivera","Pascual","De Leon","Salazar","Navarro","Cruz",
    "Del Rosario","Ocampo","Manalo","Domingo","Aguilar","Marasigan","Ilagan","Panganiban","Tolentino","Espiritu",
]
PLAN_TYPES = ["Home 25 Mbps", "Home 50 Mbps", "Business 100 Mbps", "Home 100 Mbps"]
ISSUE_TYPES = ["No Internet", "Slow Internet", "Fiber/Cable Problem", "NAP Problem", "Connection Problem", "Other"]
NAP_STATUS_WEIGHTS = [("active", 6), ("full", 2), ("maintenance", 1), ("inactive", 1)]
ISSUE_STATUS_WEIGHTS = [("pending", 4), ("assigned", 2), ("in_progress", 2), ("resolved", 1), ("closed", 1)]
PRIORITY_WEIGHTS = [("low", 3), ("medium", 4), ("high", 2), ("critical", 1)]

def weighted_choice(rng, weights):
    total = sum(w for _, w in weights)
    r = rng.uniform(0, total)
    upto = 0
    for val, w in weights:
        upto += w
        if r <= upto:
            return val
    return weights[-1][0]

# Reserved up front so the randomizer never reuses it for someone else
# (SUB-0001 is hardcoded to this name below, for customer1 continuity).
used_names = {"Ana Villanueva"}
def unique_name(rng):
    while True:
        n = rng.choice(FIRST_NAMES) + " " + rng.choice(LAST_NAMES)
        if n not in used_names:
            used_names.add(n)
            return n

def jitter(rng, base, spread):
    return round(base + rng.uniform(-spread, spread), 7)

naps = []
subscribers = []
issues = []
sub_id = 1
nap_id = 1
issue_id = 1

for name, lat, lng in BARANGAYS:
    code = CODE_OVERRIDES[name]
    total_ports = rng_total = random.choice([8, 16, 24])
    status = weighted_choice(random, NAP_STATUS_WEIGHTS)
    used_ports = random.randint(0, total_ports) if status != "inactive" else 0
    if status == "full":
        used_ports = total_ports
    available_ports = max(total_ports - used_ports, 0)

    naps.append({
        "id": nap_id,
        "nap_code": f"NAP-{code}-01",
        "name": f"{name} NAP 1",
        "address": f"Purok 1, Brgy. {name}, Sta. Cruz, Laguna",
        "lat": round(lat, 7),
        "lng": round(lng, 7),
        "total_ports": total_ports,
        "used_ports": used_ports,
        "available_ports": available_ports,
        "status": status,
        "barangay": name,
    })

    # 1-3 subscribers "connected" to this NAP (the "random connection"
    # requirement) -- each jittered a short realistic walking distance
    # from the NAP itself.
    n_subs = random.randint(1, 3)
    this_nap_subs = []
    for _ in range(n_subs):
        full_name = unique_name(random)
        slat = jitter(random, lat, 0.0018)
        slng = jitter(random, lng, 0.0018)
        sub = {
            "id": sub_id,
            "subscriber_code": f"SUB-{sub_id:04d}",
            "full_name": full_name,
            "address": f"{random.randint(1, 199)} Purok {random.randint(1, 7)}, Brgy. {name}, Sta. Cruz, Laguna",
            "lat": slat,
            "lng": slng,
            "contact_number": f"09{random.randint(170000000, 999999999)}",
            "email": full_name.lower().replace(' ', '.').replace('ñ','n') + "@example.com",
            "plan_type": random.choice(PLAN_TYPES),
            "nap_id": nap_id,
            "user_id": "NULL",
            "status": "active" if random.random() > 0.08 else "inactive",
            "installed_at": f"2025-{random.randint(1,7):02d}-{random.randint(1,28):02d}",
        }
        subscribers.append(sub)
        this_nap_subs.append(sub)
        sub_id += 1

    # 0-2 reported issues per NAP (the "random ... reported issues"
    # requirement), each pinned at the EXACT coordinates of the
    # subscriber it's reported against -- consistent with the new
    # "pin must match subscriber's exact location" rule enforced by
    # the Report Issue form.
    # Every NAP gets at least one reported issue ("each nap has ...
    # reported issues"), occasionally two.
    n_issues = random.choice([1, 1, 2])
    for _ in range(n_issues):
        sub = random.choice(this_nap_subs)
        issues.append({
            "id": issue_id,
            "issue_code": f"ISS-{issue_id:04d}",
            "issue_type": random.choice(ISSUE_TYPES),
            "description": random.choice([
                "Subscriber reports no internet since this morning.",
                "Intermittent slow speeds during peak hours.",
                "Connection drops every few hours.",
                "ONT keeps losing signal (LOS light red).",
                "Router reboots randomly, needs on-site check.",
                "Reported burnt/damaged drop cable near the NAP.",
                "Subscriber says the box near their house looks physically damaged.",
                "Speed test consistently below the subscribed plan.",
            ]),
            "priority": weighted_choice(random, PRIORITY_WEIGHTS),
            "status": weighted_choice(random, ISSUE_STATUS_WEIGHTS),
            "address": sub["address"],
            "lat": sub["lat"],
            "lng": sub["lng"],
            "subscriber_id": sub["id"],
            "nap_id": nap_id,
        })
        issue_id += 1

    nap_id += 1

# Anchor SUB-0001 to the existing customer1 login (users.id = 5), same
# continuity the previous seed data had, so logging in as
# customer1 / User@12345 still shows a real subscriber record.
subscribers[0]["user_id"] = 5
subscribers[0]["full_name"] = "Ana Villanueva"
subscribers[0]["email"] = "ana.villanueva@example.com"
subscribers[0]["contact_number"] = "09171111111"
subscribers[0]["status"] = "active"

def esc(s):
    return str(s).replace("'", "''")

lines = []
lines.append("-- =====================================================================")
lines.append("-- NAP-IQ Sample / Dummy Data")
lines.append("-- For local development and testing only. No real customer information")
lines.append("-- is used here — all names, addresses, and numbers are fictional.")
lines.append("--")
lines.append("-- Regenerated: one NAP per barangay for all 26 barangays of Sta. Cruz,")
lines.append("-- Laguna (Alipit, Bagumbayan, Bubukal, Calios, Duhat, Gatid, Jasaan,")
lines.append("-- Labuin, Malinao, Oogong, Pagsawitan, Palasan, Patimbao, Poblacion I-V,")
lines.append("-- San Jose, San Juan, San Pablo Norte/Sur, Santisima Cruz, Santo Angel")
lines.append("-- Central/Norte/Sur). Each NAP has 1-3 randomly generated connected")
lines.append("-- subscribers and 1-2 randomly generated reported technical issues, each")
lines.append("-- issue pinned at its subscriber's *exact* coordinates (required by the")
lines.append("-- Report Issue \"pin must match the subscriber's exact location\" rule).")
lines.append("-- Generated by database/gen_seed.py with random.seed(42) for reproducibility.")
lines.append("--")
lines.append("-- Usage (MySQL command line, after schema.sql has been run):")
lines.append("--   mysql -u root -p nap_iq < database/seed.sql")
lines.append("-- =====================================================================")
lines.append("")
lines.append("USE nap_iq;")
lines.append("")
lines.append("-- Note: password_hash values below are real Werkzeug pbkdf2:sha256")
lines.append("-- hashes (Phase 7), generated for these DEMO passwords only —")
lines.append("-- change them (or delete these seed rows) before any real deployment:")
lines.append("--   admin1      / Admin@12345")
lines.append("--   tech1       / Tech@12345")
lines.append("--   tech2       / Tech@12345")
lines.append("--   collector1  / Collect@12345")
lines.append("--   customer1   / User@12345")
lines.append("")
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- users")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO users (username, password_hash, full_name, role, email, phone_number, status) VALUES")
lines.append("('admin1',    'pbkdf2:sha256:1000000$3Rr8CEHSh8bQmUSv$c6903bfc58bc0a263dd6df5e8b5a1a6ad1b9b1fb15e80541c977a1cfac0afe83', 'Juana Dela Cruz',   'administrator',      'juana.delacruz@example.com', '09170000001', 'active'),")
lines.append("('tech1',     'pbkdf2:sha256:1000000$1juq9BKWzYkyYKCS$d3d239b61c93707ea9cab4e53c5a415152007688f867ac54a08d993cf028d2b6', 'Marco Reyes',       'field_assistant',         'marco.reyes@example.com',    '09170000002', 'active'),")
lines.append("('tech2',     'pbkdf2:sha256:1000000$1gNzA7t1BDj164SQ$64d656ca2b533fdc0fa37619339c03147e9ee757f1c5a10e05d221fe3d4c196e', 'Liza Fernandez',    'field_assistant',         'liza.fernandez@example.com', '09170000003', 'active'),")
lines.append("('collector1','pbkdf2:sha256:1000000$tOJDSeW1HAQ0NrUi$87fbdf4768721993e54ec39bdda17c8e4c352724a9d7dbb0eadbec36e8f874cc', 'Paolo Santos',      'payment_collector',  'paolo.santos@example.com',   '09170000004', 'active'),")
lines.append("('customer1', 'pbkdf2:sha256:1000000$OxBMrI4FkyzFasJp$a36bad799898939ff80efb51036fa5cc0354183328aa2bcac90bb6ea357358b9', 'Ana Villanueva',    'user',               'ana.villanueva@example.com', '09171111111', 'active');")
lines.append("")
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- naps -- one per barangay, all 26 barangays of Sta. Cruz, Laguna")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO naps (nap_code, name, address, latitude, longitude, total_ports, used_ports, available_ports, status) VALUES")
nap_rows = []
for n in naps:
    nap_rows.append(
        f"('{esc(n['nap_code'])}', '{esc(n['name'])}', '{esc(n['address'])}', "
        f"{n['lat']:.7f}, {n['lng']:.7f}, {n['total_ports']}, {n['used_ports']}, {n['available_ports']}, '{n['status']}')"
    )
lines.append(",\n".join(nap_rows) + ";")
lines.append("")
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- subscribers -- 1-3 randomly generated subscribers per NAP (\"random")
lines.append("-- connection\" per barangay). SUB-0001 stays linked to the customer1")
lines.append("-- user account (users.id = 5) for portal-login continuity; every other")
lines.append("-- subscriber is unlinked (user_id NULL), same as the previous seed.")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO subscribers (subscriber_code, full_name, address, latitude, longitude, contact_number, email, plan_type, nap_id, user_id, status, installed_at) VALUES")
sub_rows = []
for s in subscribers:
    sub_rows.append(
        f"('{esc(s['subscriber_code'])}', '{esc(s['full_name'])}', '{esc(s['address'])}', "
        f"{s['lat']:.7f}, {s['lng']:.7f}, '{esc(s['contact_number'])}', '{esc(s['email'])}', "
        f"'{esc(s['plan_type'])}', {s['nap_id']}, {s['user_id']}, '{s['status']}', '{s['installed_at']}')"
    )
lines.append(",\n".join(sub_rows) + ";")
lines.append("")
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- technicians (linked to the technician user accounts above)")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO technicians (user_id, full_name, contact_number, personnel_type, current_latitude, current_longitude, status, resolved_issues_count) VALUES")
lines.append("(2, 'Marco Reyes',    '09170000002', 'field_assistant', 14.2800000, 121.4140000, 'available', 14),")
lines.append("(3, 'Liza Fernandez',  '09170000003', 'field_assistant', 14.2750000, 121.4060000, 'busy',      9);")
lines.append("")
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- technical_issues -- 0-2 randomly generated reported issues per NAP,")
lines.append("-- each pinned at its subscriber's EXACT coordinates (see PIN-ERROR note")
lines.append("-- in app/routes/issues.py -- an issue's location must exactly match the")
lines.append("-- subscriber it's reported against).")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO technical_issues (issue_code, issue_type, description, priority, status, address, latitude, longitude, subscriber_id, nap_id) VALUES")
issue_rows = []
for i in issues:
    issue_rows.append(
        f"('{esc(i['issue_code'])}', '{esc(i['issue_type'])}', '{esc(i['description'])}', "
        f"'{i['priority']}', '{i['status']}', '{esc(i['address'])}', {i['lat']:.7f}, {i['lng']:.7f}, "
        f"{i['subscriber_id']}, {i['nap_id']})"
    )
lines.append(",\n".join(issue_rows) + ";")
lines.append("")

# service_requests: a small representative sample referencing real ids
sr_candidates = random.sample(subscribers, 5)
lines.append("-- ---------------------------------------------------------------------")
lines.append("-- service_requests")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO service_requests (request_type, subscriber_id, requested_nap_id, status, notes) VALUES")
nap0_name = naps[0]["name"]
napmid = naps[len(naps)//2]
napmid_name = napmid["name"]
sr_rows = [
    f"('new_installation', NULL, {naps[0]['id']}, 'pending',   'Walk-in applicant near {nap0_name}, awaiting site survey.')",
    f"('upgrade',          {sr_candidates[0]['id']}, {sr_candidates[0]['nap_id']}, 'approved',  'Upgrading plan tier per subscriber request.')",
    f"('relocation',       {sr_candidates[1]['id']}, NULL, 'pending','Subscriber moving to a new address within the same barangay.')",
    f"('new_installation', NULL, {napmid['id']}, 'scheduled', 'Site survey scheduled near {napmid_name}.')",
    f"('disconnection',    {sr_candidates[2]['id']}, NULL, 'completed', 'Subscriber requested account closure.')",
]
lines.append(",\n".join(sr_rows) + ";")
lines.append("")

lines.append("-- ---------------------------------------------------------------------")
lines.append("-- payments")
lines.append("-- ---------------------------------------------------------------------")
lines.append("INSERT INTO payments (subscriber_id, collector_id, amount, payment_method, payment_date, reference_number, status) VALUES")
pay_candidates = random.sample(subscribers, 6)
pay_rows = []
methods = ["cash", "gcash", "bank_transfer", "cash", "gcash", "cash"]
statuses = ["confirmed", "confirmed", "pending", "overdue", "confirmed", "confirmed"]
for idx, s in enumerate(pay_candidates):
    amount = random.choice([1299.00, 1599.00, 1999.00, 2499.00])
    pay_rows.append(
        f"({s['id']}, 4, {amount:.2f}, '{methods[idx]}', '2025-0{random.randint(1,7)}-{random.randint(10,28)}', "
        f"'RCPT-{idx+1:04d}', '{statuses[idx]}')"
    )
lines.append(",\n".join(pay_rows) + ";")
lines.append("")

lines.append("-- ---------------------------------------------------------------------")
lines.append("-- assignments -- one per currently-open (assigned/in_progress) issue,")
lines.append("-- alternating between the two seeded technicians.")
lines.append("-- ---------------------------------------------------------------------")
open_issues = [i for i in issues if i["status"] in ("assigned", "in_progress")]
assign_rows = []
for idx, i in enumerate(open_issues):
    tech_id = 1 if idx % 2 == 0 else 2
    score = round(random.uniform(70, 99), 2)
    assign_rows.append(f"({i['id']}, {tech_id}, '{i['status']}', {score:.2f}, NULL)")
lines.append("INSERT INTO assignments (technical_issue_id, technician_id, status, dispatch_score, completed_at) VALUES")
lines.append(",\n".join(assign_rows) + ";")
lines.append("")

lines.append("-- ---------------------------------------------------------------------")
lines.append("-- app_settings (Phase 15) — schema.sql already inserts the default")
lines.append("-- singleton row via INSERT IGNORE, so there's nothing further to seed")
lines.append("-- here; this note just documents why no INSERT appears in this file.")
lines.append("-- ---------------------------------------------------------------------")
lines.append("")

with open("/home/claude/seedgen/seed.sql", "w") as f:
    f.write("\n".join(lines))

print("naps:", len(naps))
print("subscribers:", len(subscribers))
print("issues:", len(issues))
print("open_issues (assignments):", len(open_issues))
