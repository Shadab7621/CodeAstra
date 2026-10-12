from engine.app.hlc import HLC, HybridClock


def make_clock(node="mum", start=1000):
    t = {"now": start}
    clock = HybridClock(node, time_fn=lambda: t["now"])
    return clock, t


def test_local_events_strictly_increase():
    clock, _ = make_clock()
    stamps = [clock.now() for _ in range(5)]  # physical time never advances
    assert stamps == sorted(stamps)
    assert len(set(stamps)) == 5


def test_clock_going_backwards_does_not_reorder():
    clock, t = make_clock(start=5000)
    first = clock.now()
    t["now"] = 100  # machine clock jumps far back
    second = clock.now()
    assert second > first


def test_observe_remote_makes_next_local_event_later():
    clock, _ = make_clock(start=1000)
    remote = HLC(wall=9_000_000, counter=3, node="hyd")
    clock.observe(remote)
    assert clock.now() > remote


def test_offset_shifts_wall_clock():
    clock, _ = make_clock(start=1000)
    clock.offset_ms = 3_600_000
    assert clock.now().wall == 1000 + 3_600_000


def test_total_order_breaks_ties_by_node():
    a = HLC(10, 0, "hyd")
    b = HLC(10, 0, "mum")
    assert a < b
