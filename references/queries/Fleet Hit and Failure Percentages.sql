select *, 1.0*hits/shots as CTH, 1.0*fails/shots as CTF FROM
(
select count(*) as shots from FCT_GameLog as gl where gl.RaceID = 607 and gl.MessageText like 'FTI Mop 001 attacked Caepa !D-A III%'
) as x
cross join
(
select count(*) as hits from FCT_GameLog as gl where gl.RaceID = 607 and gl.MessageText like 'FTI Mop 001 attacked Caepa !D-A III%' and gl.MessageText not like '%No Ground Units Hit%'
) as y
cross join
(
select count(*) as fails from FCT_GameLog as gl where gl.RaceID = 607 and gl.MessageText like 'A Particle Beam 4-100 on FTI Mop 001 suffered%'
) as z
--order by gl.IncrementID desc