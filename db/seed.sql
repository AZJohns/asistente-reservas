SET client_encoding = 'UTF8';

INSERT INTO reservas (nombre, telefono, fecha, hora, personas, notas) VALUES
  ('Marta',  '612345678', CURRENT_DATE + 2, '21:00', 4, 'Una persona celíaca'),
  ('Luis',   '699111222', CURRENT_DATE + 2, '21:00', 6, NULL),
  ('Ana',    '655333444', CURRENT_DATE + 3, '14:00', 2, 'Terraza'),
  ('Jorge',  '611555666', CURRENT_DATE + 5, '20:30', 3, NULL);


