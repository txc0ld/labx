"""On PYTHONPATH only for the record-write test: json.dump writes a few bytes and then fails, as a full disk would."""
import json


def dump(obj, fp, **options):
    fp.write(json.dumps(obj, **options)[:20])
    fp.flush()
    raise OSError(28, "No space left on device")


json.dump = dump
