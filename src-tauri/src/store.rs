//! In-memory app state persisted as JSON in the app config dir:
//! `settings.json` and `threads.json`.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::types::{Settings, Thread};

pub struct Store {
    dir: PathBuf,
    settings: Mutex<Settings>,
    threads: Mutex<Vec<Thread>>,
}

fn load<T: serde::de::DeserializeOwned + Default>(path: &PathBuf) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<T: serde::Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut threads: Vec<Thread> = load(&dir.join("threads.json"));
        // A turn that was streaming when the app quit can never finish.
        for t in &mut threads {
            for m in &mut t.messages {
                if m.status == crate::types::MessageStatus::Streaming {
                    m.status = crate::types::MessageStatus::Cancelled;
                }
            }
        }
        Self {
            settings: Mutex::new(load(&dir.join("settings.json"))),
            threads: Mutex::new(threads),
            dir,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update_settings<R>(&self, f: impl FnOnce(&mut Settings) -> R) -> Result<R, String> {
        let mut s = self.settings.lock().unwrap();
        let r = f(&mut s);
        save(&self.dir.join("settings.json"), &*s)?;
        Ok(r)
    }

    pub fn threads(&self) -> Vec<Thread> {
        self.threads.lock().unwrap().clone()
    }

    pub fn thread(&self, id: &str) -> Option<Thread> {
        self.threads
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .cloned()
    }

    /// Mutate the thread list and persist it.
    pub fn update_threads<R>(&self, f: impl FnOnce(&mut Vec<Thread>) -> R) -> Result<R, String> {
        let mut t = self.threads.lock().unwrap();
        let r = f(&mut t);
        save(&self.dir.join("threads.json"), &*t)?;
        Ok(r)
    }

    /// Mutate one thread (no-op if missing) and persist.
    pub fn update_thread(&self, id: &str, f: impl FnOnce(&mut Thread)) -> Result<(), String> {
        self.update_threads(|ts| {
            if let Some(t) = ts.iter_mut().find(|t| t.id == id) {
                f(t);
            }
        })
    }
}
