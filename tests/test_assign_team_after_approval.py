"""Post-approval popup assigns a TEAM (one Assignment per member)."""

from app.extensions import db
from app.models import Assignment, ServiceRequest, Technician, TechnicianTeam
from tests.conftest import login


def _setup(app):
    with app.app_context():
        techs = [Technician(full_name=n, personnel_type="technician") for n in ("Ann", "Ben")]
        db.session.add_all(techs)
        db.session.flush()
        team = TechnicianTeam(name="Team Alpha", leader_id=techs[0].id)
        team.members = techs
        empty = TechnicianTeam(name="Empty Team")
        sr = ServiceRequest(request_type="new_installation", status="scheduled")
        db.session.add_all([team, empty, sr])
        db.session.commit()
        return team.id, sr.id


def test_options_list_teams_and_assign_creates_one_assignment_per_member(app, client):
    team_id, sr_id = _setup(app)
    login(client, "admin1", "Admin@12345")

    data = client.get(f"/dispatch/requests/{sr_id}/technician-options").get_json()
    assert [t["name"] for t in data["teams"]] == ["Team Alpha"]  # empty team hidden
    assert data["teams"][0]["status"] == "recommended" and data["teams"][0]["member_count"] == 2

    r = client.post(f"/dispatch/requests/{sr_id}/assign-json", json={"team_id": team_id})
    assert r.status_code == 200 and "Team Alpha" in r.get_json()["message"]
    with app.app_context():
        assert Assignment.query.filter_by(service_request_id=sr_id).count() == 2

    # Second attempt is refused.
    assert client.post(f"/dispatch/requests/{sr_id}/assign-json", json={"team_id": team_id}).status_code == 409
