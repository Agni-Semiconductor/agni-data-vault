-- WRAPPED IN A TRANSACTION, added 2026-09-11 after a real partial failure.
-- Applying this chain to edaserver stopped at `create extension pg_trgm` (contrib was not
-- installed). ON_ERROR_STOP aborted the file -- but without a transaction the statements BEFORE
-- the failure had already committed, so the database was left holding two schemas from a
-- migration the ledger correctly recorded as never applied. This file is idempotent, so that
-- particular case recovers on a re-run; the next file's failure might not. Postgres runs DDL
-- transactionally, so the fix costs nothing.
begin;

insert into vault.option_lists (key, label, description) values
  ('people', 'People', 'People associated with samples and measurements'),
  ('instruments', 'Instruments', 'Measurement instruments'),
  ('probe_stations', 'Probe stations', 'Probe station locations'),
  ('locations', 'Locations', 'Fabrication and partner locations'),
  ('substrates', 'Substrates', 'Substrate materials'),
  ('substrate_sizes', 'Substrate sizes', 'Substrate form factors'),
  ('materials', 'Materials', 'Device-stack materials'),
  ('measurement_kinds', 'Measurement kinds', 'Measurement categories'),
  ('pad_shapes', 'Pad shapes', 'Pad geometry shapes'),
  ('file_kinds', 'File kinds', 'Uploaded file categories'),
  ('layer_roles', 'Layer roles', 'Bottom-up device-stack layer roles')
on conflict (key) do nothing;

insert into vault.option_values (list_key, value, label, sort_order) values
  ('people','spencer_ware','Spencer Ware',10), ('people','dhiren_pradhan','Dhiren Pradhan',20), ('people','harsh_yellai','Harsh Yellai',30), ('people','owen_ledger','Owen Ledger',40), ('people','zachary_anderson','Zachary Anderson',50), ('people','deep_jariwala','Deep Jariwala',60), ('people','troy_olsson','Troy Olsson',70), ('people','yunfei','Yunfei',80), ('people','saroj','Saroj',90),
  ('instruments','k4200a_clarius','Keithley 4200A-SCS (Clarius+)',10), ('instruments','k4200a_pmu','Keithley 4200A + 4225-PMU',20), ('instruments','relay_board_8x8','8x8 relay board (Pico)',30), ('instruments','other','Other',40),
  ('probe_stations','jariwala_station','Jariwala lab probe station',10), ('probe_stations','olsson_station','Olsson lab probe station',20), ('probe_stations','hot_chuck_station','High-T hot-chuck station',30), ('probe_stations','other','Other',40),
  ('locations','penn_qnf','Penn QNF / Singh Center',10), ('locations','penn_jariwala_olsson_lab','Jariwala-Olsson lab (Penn)',20), ('locations','ge_aerospace','GE Aerospace',30), ('locations','ozark','Ozark',40), ('locations','nhanced','Nhanced',50), ('locations','neu','Northeastern (NEU)',60), ('locations','afrl','AFRL',70), ('locations','other','Other',80),
  ('substrates','sapphire','Sapphire',10), ('substrates','sic','SiC',20), ('substrates','si','Si',30), ('substrates','soi','SOI',40), ('substrates','ltcc','LTCC',50), ('substrates','other','Other',60),
  ('substrate_sizes','wafer_4in','4-inch wafer',10), ('substrate_sizes','wafer_6in','6-inch wafer',20), ('substrate_sizes','piece_1x1cm','1 x 1 cm piece',30), ('substrate_sizes','piece_2x2cm','2 x 2 cm piece',40), ('substrate_sizes','die','Die',50), ('substrate_sizes','other','Other',60),
  ('materials','alscn','AlScN',10), ('materials','albscn','AlBScN',20), ('materials','aln','AlN',30), ('materials','al','Al',40), ('materials','hfn','HfN',50), ('materials','hf','Hf',60), ('materials','pt','Pt',70), ('materials','ni','Ni',80), ('materials','ti','Ti',90), ('materials','au','Au',100), ('materials','cr','Cr',110), ('materials','tiw','TiW',120), ('materials','tin','TiN',130), ('materials','alox','AlOx',140), ('materials','hfo2','HfO2',150), ('materials','sio2','SiO2',160), ('materials','sapphire','Sapphire',170), ('materials','sic','SiC',180),
  ('measurement_kinds','dciv','DC I-V',10), ('measurement_kinds','aciv','AC I-V / hysteresis',20), ('measurement_kinds','pund','PUND',30), ('measurement_kinds','pulse','Pulse train',40), ('measurement_kinds','cv','C-V',50), ('measurement_kinds','res2t','2-terminal resistance',60), ('measurement_kinds','endurance','Endurance',70), ('measurement_kinds','retention','Retention',80), ('measurement_kinds','other','Other',90),
  ('pad_shapes','circle','Circle',10), ('pad_shapes','square','Square',20),
  ('file_kinds','raw_xls','Clarius export (xls/xlsx)',10), ('file_kinds','raw_csv','CSV',20), ('file_kinds','plot_png','Plot image',30), ('file_kinds','other','Other',40),
  ('layer_roles','substrate','Substrate',10), ('layer_roles','bottom_metal','Bottom metal',20), ('layer_roles','il_bot','Bottom interlayer',30), ('layer_roles','fe','Ferroelectric',40), ('layer_roles','il_top','Top interlayer',50), ('layer_roles','top_metal','Top metal',60), ('layer_roles','other','Other',70)
on conflict (list_key, value) do nothing;

insert into vault.allowlist (email, role) values ('spencer.ware@agnisemi.ai', 'admin') on conflict (email) do nothing;

commit;
