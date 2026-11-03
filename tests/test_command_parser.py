import pytest

from kagecatch.self_control.commands import CommandAction, parse_command


@pytest.mark.parametrize(
    ("text", "action", "bot"),
    [
        (".پنل", CommandAction.PANEL, None),
        (".روشن", CommandAction.ENABLE_ALL, None),
        (".خاموش", CommandAction.DISABLE_ALL, None),
        (".وضعیت", CommandAction.STATUS, None),
        (".آمار", CommandAction.STATS, None),
        (".سهمیه", CommandAction.QUOTA, None),
        (".بات ها", CommandAction.BOTS, None),
        (".راهنما", CommandAction.HELP, None),
        (".روشن سنپای", CommandAction.ENABLE_BOT, "senpai"),
        (".خاموش هنتا", CommandAction.DISABLE_BOT, "henta"),
        (".روشن کاراکتر", CommandAction.ENABLE_BOT, "character"),
    ],
)
def test_parse_supported_commands(text, action, bot):
    command = parse_command(text)

    assert command is not None
    assert command.action is action
    assert command.bot == bot


def test_parser_ignores_unrecognized_or_non_command_text():
    assert parse_command("سلام") is None
    assert parse_command(".حذف همه") is None
    assert parse_command(".") is None


def test_parser_ignores_leading_and_trailing_whitespace():
    command = parse_command("  .خاموش سنپای  ")

    assert command is not None
    assert command.action is CommandAction.DISABLE_BOT
    assert command.bot == "senpai"
