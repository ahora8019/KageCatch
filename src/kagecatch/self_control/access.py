"""Strict source validation for self-control messages."""


def is_authorized_saved_message(
    *,
    session_user_id: int | str,
    sender_user_id: int | str | None,
    chat_id: int | str | None,
    is_outgoing: bool,
    is_saved_messages: bool,
) -> bool:
    """Allow only the account owner's own outgoing Saved Messages commands."""
    owner = str(session_user_id)
    return all(
        (
            is_outgoing,
            is_saved_messages,
            sender_user_id is not None and str(sender_user_id) == owner,
            chat_id is not None and str(chat_id) == owner,
        )
    )
