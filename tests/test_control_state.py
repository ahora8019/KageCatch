from kagecatch.self_control import BotName, ControlState


def test_new_user_starts_disabled_and_listener_is_independent():
    state = ControlState(user_id="user-1", listener_connected=True)

    assert state.auto_catch_enabled is False
    assert state.listener_connected is True
    assert state.can_auto_catch(BotName.SENPAI) is False


def test_global_off_pauses_catch_without_disconnecting_listener():
    state = ControlState(user_id="user-1", listener_connected=True)
    state.enable_global()
    state.enable_bot(BotName.SENPAI)

    state.disable_global()

    assert state.auto_catch_enabled is False
    assert state.listener_connected is True
    assert state.can_auto_catch(BotName.SENPAI) is False


def test_bot_pause_is_independent_from_other_bots():
    state = ControlState(user_id="user-1")
    state.enable_global()
    state.enable_bot(BotName.SENPAI)
    state.enable_bot(BotName.HENTA)

    state.disable_bot(BotName.SENPAI)

    assert state.can_auto_catch(BotName.SENPAI) is False
    assert state.can_auto_catch(BotName.HENTA) is True


def test_safety_conditions_override_user_enablement():
    state = ControlState(user_id="user-1")
    state.enable_global()
    state.enable_bot(BotName.SENPAI)

    assert state.can_auto_catch(BotName.SENPAI, safety_locked=True) is False
    assert state.can_auto_catch(BotName.SENPAI, quota_available=False) is False
    assert state.can_auto_catch(BotName.SENPAI, flood_wait=True) is False


def test_enable_global_does_not_enable_any_bot_implicitly():
    state = ControlState(user_id="user-1")
    state.enable_global()

    assert state.can_auto_catch(BotName.SENPAI) is False


def test_each_user_has_independent_control_state():
    first = ControlState(user_id="user-1")
    second = ControlState(user_id="user-2")
    first.enable_global()
    first.enable_bot(BotName.SENPAI)

    assert first.can_auto_catch(BotName.SENPAI) is True
    assert second.can_auto_catch(BotName.SENPAI) is False


def test_blank_user_id_is_rejected():
    import pytest

    with pytest.raises(ValueError, match="user_id"):
        ControlState(user_id="  ")
