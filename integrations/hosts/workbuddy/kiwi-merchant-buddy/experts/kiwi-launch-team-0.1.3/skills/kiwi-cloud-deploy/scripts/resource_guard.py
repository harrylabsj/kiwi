"""Bound offline tar inspection in a child process; not an OS sandbox."""

def apply_limits():
    try:
        import resource
        for name, requested in (('RLIMIT_CPU',90),('RLIMIT_FSIZE',1024*1024),('RLIMIT_NOFILE',256)):
            kind=getattr(resource,name)
            soft,hard=resource.getrlimit(kind)
            cap=requested if hard == resource.RLIM_INFINITY else min(requested,hard)
            if soft != resource.RLIM_INFINITY: cap=min(cap,soft)
            resource.setrlimit(kind,(cap,hard))
        # Darwin may reject RLIMIT_AS. In that case bounded pre-scanning is
        # mandatory, but it is not equivalent to an OS memory sandbox.
        try:
            kind=resource.RLIMIT_AS
            soft,hard=resource.getrlimit(kind)
            cap=1024*1024*1024 if hard == resource.RLIM_INFINITY else min(1024*1024*1024,hard)
            if soft != resource.RLIM_INFINITY: cap=min(cap,soft)
            resource.setrlimit(kind,(cap,hard))
        except (AttributeError,OSError,ValueError):
            pass
    except (ImportError,AttributeError,OSError,ValueError) as error:
        raise RuntimeError('RESOURCE_LIMIT_UNAVAILABLE') from error
