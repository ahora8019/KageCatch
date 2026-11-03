from kagecatch.self_control.access import is_authorized_saved_message


def test_accepts_only_outgoing_saved_messages_from_same_account():
    assert is_authorized_saved_message(
        session_user_id=123,
        sender_user_id=123,
        chat_id=123,
        is_outgoing=True,
        is_saved_messages=True,
    ) is True


def test_rejects_messages_from_other_users():
    assert is_authorized_saved_message(
        session_user_id=123,
        sender_user_id=456,
        chat_id=123,
        is_outgoing=False,
        is_saved_messages=True,
    ) is False


def test_rejects_groups_even_if_sender_is_the_account_owner():
    assert is_authorized_saved_message(
        session_user_id=123,
        sender_user_id=123,
        chat_id=-100123,
        is_outgoing=True,
        is_saved_messages=False,
    ) is False


def test_rejects_outgoing_messages_to_other_private_chats():
    assert is_authorized_saved_message(
        session_user_id=123,
        sender_user_id=123,
        chat_id=789,
        is_outgoing=True,
        is_saved_messages=False,
    ) is False
