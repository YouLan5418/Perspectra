"""Identity/template cleanup for retrieval only; no name inference or evidence rewriting."""
import re
import core

RULE = "authorized-identity-template/v1"
MIN_CONTENT_CHARS = 2

def content_length(text):
    return sum(c.isalnum() for c in text)

CHARACTER_ID = re.compile(r"character:[a-zA-Z0-9_-]+")


def context_names(context):
    return [o for o in [context.get("character", {}), *context.get("scene", {}).get("people", [])]
            if isinstance(o, dict) and isinstance(o.get("characterId"), str)
            and isinstance(o.get("name"), str) and o["name"].strip()]


def alias_table(doc, history=()):
    sources = core.check_sources(doc)
    scope = doc["scope"]
    identities = {m for s in sources for m in CHARACTER_ID.findall(s["text"])}
    rows = {}
    for entry in history:
        owner = entry["scope"]
        if owner["worldAddress"] != scope["worldAddress"] or owner["characterId"] != scope["characterId"]:
            raise ValueError("alias history crosses character or world")
        if entry["worldSeq"] > scope["asOfWorldSeq"]:
            continue
        for person in entry["people"]:
            ident, name = person["characterId"], person["name"]
            if not CHARACTER_ID.fullmatch(ident) or not name.strip():
                continue
            witnesses = [s["sourceId"] for s in sources if name in s["text"] or ident in s["text"]]
            if witnesses:
                known = min(entry["worldSeq"], rows.get((ident,name), {}).get("knownByWorldSeq", entry["worldSeq"]))
                rows[(ident, name)] = {"characterId": ident, "name": name,
                                      "knownByWorldSeq": known, "sourceIds": witnesses}
                identities.add(ident)
    return {"rule": RULE, "scope": scope, "people": sorted(rows.values(), key=lambda r:(r["characterId"], r["name"])),
            "characterIds": sorted(identities)}


def clean(text, table):
    names = {r["name"] for r in table["people"]}
    ids = table["characterIds"]
    for ident in sorted(ids, key=lambda n:(-len(n),n)):
        text = re.sub(re.escape(ident) + r"(?![a-zA-Z0-9_-])", " ", text)
        names.add(ident.split(":")[-1])
    for name in sorted(names, key=lambda n:(-len(n),n)):
        if name.isascii():
            text = re.sub(r"(?<![a-zA-Z0-9_])" + re.escape(name) + r"(?![a-zA-Z0-9_])", " ", text)
        else:
            text = text.replace(name, " ")
    text = text.replace("观察到行动结果：", "").replace("外显叙述：", "")
    text = text.replace("尝试未成功：", "未成功：").replace("结果未提供的行动记录：", "结果未提供：")
    while text.startswith("【主观认识，可修正】"):
        text = text[len("【主观认识，可修正】"):]
    text = re.sub(r"([、,，])(?:\s*[、,，])+", r"\1", text)
    return re.sub(r"\s+", " ", text).strip().lstrip("、,，:：;； ").rstrip()


def query_text(text, projection):
    table = projection["retrievalAliases"]
    if table["scope"] != projection["scope"]:
        raise ValueError("query cleanup alias scope differs")
    return clean(text, table)
