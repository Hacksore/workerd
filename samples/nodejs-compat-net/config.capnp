using Workerd = import "/workerd/workerd.capnp";

const nodeNetExample :Workerd.Config = (

  services = [
    (name = "main", worker = .worker),
    (name = "internet", network = (
      allow = ["private"]
    ))
  ],
  sockets = [ ( name = "http", address = "*:8080", http = (), service = "main" ) ]
);

const worker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker.js")
  ],
  compatibilityDate = "2024-05-31",
  compatibilityFlags = ["nodejs_compat_v2", "experimental"]
);
